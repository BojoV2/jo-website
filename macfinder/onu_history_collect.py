#!/usr/bin/env python3
"""
onu_history_collect.py — background poller for the "Traffic/Signal" trend
graph in OLT MAC Finder, and the fleet-wide auto-discovery sweep: every
active ONU across all 34 OLTs (~8,900 clients measured live) gets tracked
automatically, not just ones someone searched for.

SAFETY — this is the single biggest-blast-radius thing built for this app,
and it caused a REAL INCIDENT on 2026-09-10: a manual test run overlapped
with a cron-triggered sweep and both hit the fleet (including .210, PON9)
at the same moment (5pm PHT = 09:00 UTC, confirmed against the log), very
likely disrupting that PON. Root cause: the global `flock` on this script
only prevents CRON from double-firing — it does nothing to stop a manually
invoked run from overlapping with one already in progress. That gap is
closed for good below. Four independent guards now exist:
  1. **Per-OLT lock + minimum revisit interval (`olt_gate()`)** — added
     after the incident above. A real OS file lock per OLT IP means it is
     now IMPOSSIBLE for two requests, from cron or a manual run or a future
     bug, to ever hit the same OLT concurrently — the second one skips that
     OLT cleanly instead of queuing or waiting. A per-OLT minimum interval
     (`MIN_OLT_REVISIT_S`) on top of that means even sequential runs can't
     hit the same OLT more often than once every few minutes, no matter how
     many times a human re-runs this script by hand. This is the guard that
     would have prevented the incident; do not remove it, and never invoke
     `discover_olt()` directly bypassing it.
  2. Per-OLT requests are SEQUENTIAL with a small pacing delay
     (REQUEST_GAP_S) — never more than one in flight against a single OLT.
  3. Only FLEET_OLT_CONCURRENCY OLTs are swept in parallel — bounds total
     concurrent load across the whole fleet regardless of OLT count.
  4. A host load-average circuit breaker (load_ok()) skips the entire sweep
     for this cycle if THIS box is already busy, rather than adding more
     load on top.
Fallback: if any of this proves too heavy in practice, the safe reset is to
raise REQUEST_GAP_S / lower FLEET_OLT_CONCURRENCY / raise MIN_OLT_REVISIT_S —
all single constants below, no architecture change needed.

STANDING RULE, reaffirmed by the user after the incident above: this
project NEVER connects to MikroTik for ANY purpose, not even read-only SNMP
identification — the same "don't hit production network gear too hard"
concern applies there as much as to the OLTs. Do not reintroduce any
MikroTik/RADIUS code path here, ever, regardless of how it's justified.

Traffic source — final answer, after five iterations (2026-09-10):
1. NOT OLT SNMP aggregate — GPON has no per-ONU bitrate counter without
   OMCI via SNMP (see app.py's fetch_pon_traffic() docstring).
2. NOT MikroTik RADIUS accounting octets — confirmed live: frozen at 0.
3. NOT routed through the new .217 LibreNMS — its discovery deletes any
   ifIndex outside its type allowlist on every poll cycle.
4. NOT a MikroTik NAS-router SNMP walk either (an earlier iteration of this
   file did exactly that, matching PPPoE usernames to router interfaces) —
   replaced entirely once the user found something better:
5. THE OLT'S OWN "ONU Statistics" PAGE (`action/onustatistics.html`, under
   ONU Configuration → ONU Authlist → ONU Statistics in the web UI) reports
   real OMCI-sourced cumulative Input/Output bytes per ONU, for an ENTIRE
   PON's worth of ONUs in ONE request. This is strictly better than the
   MikroTik approach on every axis: no MikroTik/RADIUS touch of any kind,
   works for every ONU regardless of PPPoE vs bridge mode (not just the
   ~64% that have a PPPoE session), and the numbers are real per-ONU device
   counters instead of inferred via an upstream router interface. One
   request per PON (not per client) replaced the entire NAS-router-walk
   subsystem. Counters are 32-bit (wrap at 2^32 bytes) — diffing handles a
   single wrap between polls; see diff_wrap().
   Input bytes = traffic the OLT received FROM the ONU = upload.
   Output bytes = traffic the OLT sent TO the ONU = download.
"""
import contextlib
import fcntl
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
import urllib3

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from app import (  # noqa: E402
    CREDS_PATH, FIRMWARE_PREFIXES, HISTORY_RETENTION_DAYS, OLTS_PATH,
    ROW_RE, SPA_OPTICAL_PROPS, _spa_get_json, _spa_props, creds_for, db,
    fetch_onu_optical, fetch_onu_status, load_json, spa_login,
)

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

POLL_TIMEOUT = (4, 8)  # (connect, read) — matches app.py's CONNECT_TIMEOUT/READ_TIMEOUT

# --- Fleet-sweep safety knobs (see module docstring) -----------------------
FLEET_OLT_CONCURRENCY = 8     # OLTs swept in parallel, fleet-wide (each OLT itself stays sequential)
REQUEST_GAP_S = 0.15          # pacing delay between requests to the SAME OLT
LOAD_GUARD_PER_CPU = 1.5      # skip the sweep if 1-min loadavg exceeds this * cpu_count
OLT_LOCK_DIR = "/tmp/olt-locks"       # one lock file per OLT IP — see olt_gate()
MIN_OLT_REVISIT_S = 240       # never contact the same OLT more than once per 4 min,
                              # regardless of which process/run is asking (cron, a
                              # manual test, anything) — comfortably under the 5-min
                              # cron cadence for normal operation, but makes the
                              # 2026-09-10 incident (see module docstring) structurally
                              # impossible: that was two processes hitting the same
                              # OLT (.210, PON9) at the same moment.


@contextlib.contextmanager
def olt_gate(ip):
    """Guarantees at most one request in flight against this OLT, fleet-wide
    across ALL processes, and refuses to contact it again within
    MIN_OLT_REVISIT_S of the last contact — even if that contact was from a
    completely different process. Yields True if this OLT may be contacted
    now (caller proceeds and MUST do its work inside the `with` block so the
    lock covers the whole request sequence), False if it should be skipped
    entirely this cycle (already in use, or contacted too recently).

    This is deliberately filesystem-based (an flock'd file whose mtime is
    the last-contact timestamp) rather than in-memory or DB-based, because
    the whole point is protection ACROSS separate OS processes — a cron run
    and a manually-invoked `python onu_history_collect.py` must be unable to
    race each other against the same OLT, which is exactly what happened in
    the incident this guard exists to prevent."""
    os.makedirs(OLT_LOCK_DIR, exist_ok=True)
    path = os.path.join(OLT_LOCK_DIR, ip.replace("/", "_"))
    fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o644)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print(f"OLT {ip}: SKIPPED, another process is currently contacting it", flush=True)
            yield False
            return
        try:
            last_ts = os.fstat(fd).st_mtime
            age = time.time() - last_ts
            if age < MIN_OLT_REVISIT_S:
                print(f"OLT {ip}: SKIPPED, contacted {age:.0f}s ago (min revisit interval {MIN_OLT_REVISIT_S}s)", flush=True)
                yield False
                return
            yield True
            os.utime(path, None)  # mark contact time AFTER finishing, not before
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)

# --- Traffic math ------------------------------------------------------------
COUNTER_WRAP = 2 ** 32          # OLT's Input/Output byte counters are 32-bit
MAX_PLAUSIBLE_KBPS = 2_000_000  # ~2 Gbps sanity ceiling per ONU; above this, treat as a
                                 # multi-wrap gap or an OLT-side counter reset, not real traffic

_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")
STATS_ROW_RE = re.compile(
    r"<td>GPON0/\d+:(\d+)</td><td>([^<]*)</td><td>[^<]*</td><td>([^<]*)</td><td>[^<]*</td>"
)


def _num(v):
    """Optical fields come back like '-21.16dBm' or '-21.16' or None/'N/A'."""
    if v in (None, "", "N/A"):
        return None
    m = _NUM_RE.search(str(v))
    return float(m.group(0)) if m else None


def load_ok():
    try:
        cpus = os.cpu_count() or 1
        load1 = os.getloadavg()[0]
        ok = load1 < cpus * LOAD_GUARD_PER_CPU
        if not ok:
            print(f"fleet sweep SKIPPED: loadavg {load1:.2f} >= {cpus}*{LOAD_GUARD_PER_CPU} threshold", flush=True)
        return ok
    except (OSError, AttributeError):
        return True  # can't check on this platform — don't block on it


def fetch_pon_statistics(sess, host, pon, max_onu_seen):
    """Bulk per-PON ONU byte counters straight from the OLT's own OMCI-backed
    ONU Statistics page — one request per `onu_group` (ONUs 1-64, then 65-128
    only if this PON actually has an ONU numbered above 64) covers every
    provisioned ONU on that PON in a single page load. Returns
    {onu_number_str: (in_bytes, out_bytes)}, skipping NULL (unprovisioned)
    rows entirely rather than treating them as zero traffic."""
    stats = {}
    groups = [0]
    try:
        if max_onu_seen and int(max_onu_seen) > 64:
            groups.append(1)
    except (TypeError, ValueError):
        pass
    for group in groups:
        try:
            r = sess.get(
                f"https://{host}/action/onustatistics.html",
                params={"who": 100, "pon": pon, "onu_group": group},
                timeout=POLL_TIMEOUT,
            )
        except requests.exceptions.RequestException:
            continue
        for onu, in_b, out_b in STATS_ROW_RE.findall(r.text):
            if in_b == "NULL" or out_b == "NULL":
                continue
            try:
                stats[onu] = (int(in_b), int(out_b))
            except ValueError:
                continue
    return stats


def diff_wrap(new, old, wrap=COUNTER_WRAP):
    """32-bit counter delta, tolerant of exactly one wrap between polls."""
    if new >= old:
        return new - old
    return (wrap - old) + new


def compute_traffic(cache_row, in_bytes, out_bytes, now):
    """Returns (up_kbps, down_kbps) or (None, None) — None on first sighting
    of this mac (baseline only) or an implausible delta (treated as a
    multi-wrap gap / OLT-side counter reset, not real traffic; see
    MAX_PLAUSIBLE_KBPS). Input bytes=upload, Output bytes=download (OLT's
    own perspective: received-from-ONU vs sent-to-ONU)."""
    if in_bytes is None or out_bytes is None or cache_row is None:
        return None, None
    elapsed = now - cache_row["ts"]
    if elapsed < 1:
        return None, None
    up_kbps = round(diff_wrap(in_bytes, cache_row["up_octets"]) * 8 / 1000 / elapsed, 2)
    down_kbps = round(diff_wrap(out_bytes, cache_row["down_octets"]) * 8 / 1000 / elapsed, 2)
    # diff_wrap() assumes old <= new modulo one wrap; a cache_row holding a
    # value that isn't actually a prior read of THIS SAME counter (e.g. a
    # leftover row from the old MikroTik-SNMP-octet system, a completely
    # different number scale) breaks that assumption and can produce a
    # huge value in EITHER direction, including negative. Real traffic is
    # never negative and never implausibly large, so reject both.
    if not (0 <= up_kbps <= MAX_PLAUSIBLE_KBPS) or not (0 <= down_kbps <= MAX_PLAUSIBLE_KBPS):
        return None, None
    return up_kbps, down_kbps


# --- Fleet-wide discovery: one throttled sweep of every OLT -----------------

def discover_olt(olt):
    """Gate this OLT (see olt_gate() docstring) before doing ANY work — the
    entire request sequence for this OLT happens inside the lock, and the
    lock is only released after we're done, so a second call for the same
    OLT (cron, a manual test, anything) either waits for nothing and skips
    cleanly, or is blocked out for MIN_OLT_REVISIT_S after we finish. This
    is the fix for the 2026-09-10 incident — see module docstring."""
    with olt_gate(olt["ip"]) as ok:
        if not ok:
            return []
        return _discover_olt_locked(olt)


def _discover_olt_locked(olt):
    """Logs into ONE OLT ONCE, reuses that session for every ONU currently
    online on it. macinfoPon gives the whole client roster in one request;
    onustatistics.html gives every ONU's traffic on a given PON in one
    request each. Only per-ONU optical still needs one request per ONU (no
    bulk equivalent exists for that). Sequential within this function by
    design — see module docstring. Returns a list of dicts: mac/ip/port/pon/
    onu/label/location/rx/tx/in_bytes/out_bytes. Only ever called from
    discover_olt() with that OLT's lock already held — never call directly."""
    creds_cfg = load_json(CREDS_PATH)
    ip = olt["ip"]
    port = olt.get("port")
    host = f"{ip}:{port}" if port else ip
    dead = load_json(CREDS_PATH).get("known_dead", {})
    if ip in dead:
        return []

    user, pw = creds_for(ip, creds_cfg)
    sess = requests.Session()
    sess.verify = False
    common = {"ip": ip, "port": port, "label": olt.get("label"), "location": olt.get("location")}

    try:
        login = sess.post(
            f"https://{host}/action/main.html",
            data={"user": user, "pass": pw, "who": 100},
            timeout=POLL_TIMEOUT,
        )
    except requests.exceptions.RequestException:
        return []

    entries = []
    if "mainFrame" in login.text:
        try:
            page = sess.get(f"https://{host}/action/macinfoPon.html", params={"who": 100, "macport": 0}, timeout=POLL_TIMEOUT)
        except requests.exceptions.RequestException:
            return []
        seen = {}
        for _idx, _vlan, mac, _mtype, pon, onu in ROW_RE.findall(page.text):
            seen[mac.lower()] = (pon, onu)

        by_pon = {}
        for mac, (pon, onu) in seen.items():
            by_pon.setdefault(pon, []).append(onu)
        pon_stats = {}
        for pon, onus in by_pon.items():
            time.sleep(REQUEST_GAP_S)
            pon_stats[pon] = fetch_pon_statistics(sess, host, pon, max(onus, key=int))

        for mac, (pon, onu) in seen.items():
            time.sleep(REQUEST_GAP_S)
            prefix = FIRMWARE_PREFIXES[0]
            for candidate in FIRMWARE_PREFIXES:
                _status, valid = fetch_onu_status(sess, host, candidate, pon, onu)
                if valid:
                    prefix = candidate
                    break
            optical = fetch_onu_optical(sess, host, prefix, pon, onu)
            in_bytes, out_bytes = pon_stats.get(pon, {}).get(onu, (None, None))
            entries.append({
                **common, "mac": mac, "pon": pon, "onu": onu,
                "rx": _num(optical.get("rx_power_dbm")), "tx": _num(optical.get("tx_power_dbm")),
                "in_bytes": in_bytes, "out_bytes": out_bytes,
            })
        return entries

    # Vue-SPA firmware family (a couple of OLTs). onustatistics.html's bulk
    # per-PON page hasn't been confirmed to exist for this family — these
    # ONUs get signal-only history for now (same as before this rewrite).
    if not spa_login(sess, host, user, pw):
        return []
    data = _spa_get_json(sess, host, "macinfoPon", {})
    seen = {}
    for row in data.get("pon_max_list", []):
        mac = (row.get("mac") or "").lower()
        pononu = row.get("ponOnu") or ""
        if mac and ":" in pononu:
            pon, onu = pononu.split(":", 1)
            seen[mac] = (pon, onu)
    for mac, (pon, onu) in seen.items():
        time.sleep(REQUEST_GAP_S)
        optical = _spa_props(sess, host, "gpononuoptical", pon, onu, "onu_optical_info", SPA_OPTICAL_PROPS)
        entries.append({
            **common, "mac": mac, "pon": pon, "onu": onu,
            "rx": _num(optical.get("rx_power_dbm")), "tx": _num(optical.get("tx_power_dbm")),
            "in_bytes": None, "out_bytes": None,
        })
    return entries


def fleet_sweep(conn):
    """The auto-discovery pass: every active ONU on every OLT gets upserted
    into watchlist, and one onu_history row is written per mac containing
    BOTH signal and (where available) traffic — the sweep already fetched
    everything needed for both, no separate traffic phase required."""
    if not load_ok():
        return set()

    olts = load_json(OLTS_PATH)
    limit = os.environ.get("DISCOVER_LIMIT")  # manual rollout safety valve, unset in normal cron use
    if limit:
        olts = olts[: int(limit)]
        print(f"DISCOVER_LIMIT set — sweeping only the first {len(olts)} OLTs", flush=True)

    t0 = time.time()
    all_entries = []
    with ThreadPoolExecutor(max_workers=FLEET_OLT_CONCURRENCY) as pool:
        futures = {pool.submit(discover_olt, olt): olt for olt in olts}
        for fut in as_completed(futures):
            olt = futures[fut]
            try:
                all_entries.extend(fut.result())
            except Exception as e:  # noqa: BLE001 — one bad OLT never aborts the sweep
                print(f"discover_olt({olt['ip']}) EXCEPTION: {type(e).__name__}: {e}", flush=True)

    print(f"fleet sweep: {len(all_entries)} ONUs across {len(olts)} OLTs in {time.time() - t0:.1f}s", flush=True)

    now = time.time()
    cache_rows = {r["mac"]: r for r in conn.execute("SELECT * FROM octet_cache").fetchall()}
    touched = set()
    traffic_count = 0
    for e in all_entries:
        mac = e["mac"]
        conn.execute(
            """INSERT INTO watchlist(mac, ip, port, pon, onu, label, location, added_ts, last_seen)
               VALUES(?,?,?,?,?,?,?,?,?)
               ON CONFLICT(mac) DO UPDATE SET
                 ip=excluded.ip, port=excluded.port, pon=excluded.pon, onu=excluded.onu,
                 label=excluded.label, location=excluded.location, last_seen=excluded.last_seen""",
            (mac, e["ip"], e["port"], e["pon"], e["onu"], e["label"], e["location"], now, now),
        )

        up_kbps, down_kbps = compute_traffic(cache_rows.get(mac), e["in_bytes"], e["out_bytes"], now)
        if e["in_bytes"] is not None and e["out_bytes"] is not None:
            conn.execute(
                "INSERT INTO octet_cache(mac, up_octets, down_octets, ts) VALUES(?,?,?,?) "
                "ON CONFLICT(mac) DO UPDATE SET up_octets=excluded.up_octets, "
                "down_octets=excluded.down_octets, ts=excluded.ts",
                (mac, e["in_bytes"], e["out_bytes"], now),
            )
        if up_kbps is not None:
            traffic_count += 1

        conn.execute(
            "INSERT INTO onu_history(mac, ts, rx_dbm, tx_dbm, up_kbps, down_kbps) VALUES(?,?,?,?,?,?)",
            (mac, now, e["rx"], e["tx"], up_kbps, down_kbps),
        )
        conn.commit()
        touched.add(mac)

    print(f"traffic: {traffic_count} of {len(all_entries)} ONUs got a real diffed rate this cycle", flush=True)
    return touched


def poll_optical(ip, port, pon, onu, creds_cfg):
    """Same per-OLT gate as discover_olt() — this is a separate code path
    that also contacts an OLT directly and must be equally protected."""
    with olt_gate(ip) as ok:
        if not ok:
            return {}
        return _poll_optical_locked(ip, port, pon, onu, creds_cfg)


def _poll_optical_locked(ip, port, pon, onu, creds_cfg):
    """Fallback single-mac signal poll for a watchlist entry the fleet sweep
    didn't cover this cycle (a search-tracked mac on one of the few
    dead/unreachable OLTs, mainly). No traffic here — the bulk per-PON stats
    page is only fetched during the main sweep pass. Only ever called from
    poll_optical() with that OLT's lock already held."""
    host = f"{ip}:{port}" if port else ip
    user, pw = creds_for(ip, creds_cfg)
    sess = requests.Session()
    sess.verify = False
    try:
        login = sess.post(
            f"https://{host}/action/main.html",
            data={"user": user, "pass": pw, "who": 100},
            timeout=POLL_TIMEOUT,
        )
    except requests.exceptions.RequestException:
        return {}

    if "mainFrame" in login.text:
        prefix = FIRMWARE_PREFIXES[0]
        for candidate in FIRMWARE_PREFIXES:
            _status, valid = fetch_onu_status(sess, host, candidate, pon, onu)
            if valid:
                prefix = candidate
                break
        return fetch_onu_optical(sess, host, prefix, pon, onu)

    if not spa_login(sess, host, user, pw):
        return {}
    return _spa_props(sess, host, "gpononuoptical", pon, onu, "onu_optical_info", SPA_OPTICAL_PROPS)


def main():
    creds_cfg = load_json(CREDS_PATH)
    now = time.time()

    conn = db()

    print(f"--- run {time.strftime('%F %T')} ---", flush=True)
    touched_by_sweep = fleet_sweep(conn)

    watchlist = conn.execute("SELECT mac, ip, port, pon, onu FROM watchlist").fetchall()
    print(f"watchlist: {len(watchlist)} total, {len(touched_by_sweep)} covered by this sweep", flush=True)

    # Signal fallback: anything the sweep didn't reach this cycle (a
    # search-tracked mac on one of the handful of dead/unreachable/SPA OLTs).
    for row in watchlist:
        if row["mac"] in touched_by_sweep:
            continue
        optical = poll_optical(row["ip"], row["port"], row["pon"], row["onu"], creds_cfg)
        rx = _num(optical.get("rx_power_dbm"))
        tx = _num(optical.get("tx_power_dbm"))
        conn.execute(
            "INSERT INTO onu_history(mac, ts, rx_dbm, tx_dbm, up_kbps, down_kbps) VALUES(?,?,?,?,NULL,NULL)",
            (row["mac"], now, rx, tx),
        )
        conn.commit()

    cutoff = now - HISTORY_RETENTION_DAYS * 86400
    conn.execute("DELETE FROM onu_history WHERE ts < ?", (cutoff,))
    conn.commit()
    conn.close()


if __name__ == "__main__":
    main()
