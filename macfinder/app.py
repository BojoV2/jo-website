"""
OLT MAC Finder — scans every OLT in the fleet (config/olts.json) for a given
CALLER-ID / client MAC address, by logging into each OLT's web UI (read-only:
GET requests only, no config pages touched) and searching its per-PON MAC
address table (action/macinfoPon.html).

Run: python app.py   -> http://127.0.0.1:5000
Requires the iniSupport VPN (or being on the 10.86 LAN) to reach 192.168.200.0/24.
"""
import asyncio
import json
import os
import re
import sqlite3
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import librouteros
import requests
import urllib3
from pysnmp.hlapi.v3arch.asyncio import (
    SnmpEngine, CommunityData, UdpTransportTarget, ContextData,
    ObjectType, ObjectIdentity, get_cmd,
)
from flask import Flask, jsonify, render_template, request
from librouteros.query import Key

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OLTS_PATH = os.path.join(BASE_DIR, "config", "olts.json")
CREDS_PATH = os.path.join(BASE_DIR, "config", "creds.json")
MIKROTIK_PATH = os.path.join(BASE_DIR, "config", "mikrotik.json")
SNMP_PATH = os.path.join(BASE_DIR, "config", "snmp.json")

CONNECT_TIMEOUT = 4
READ_TIMEOUT = 8
MAX_WORKERS = 12

app = Flask(__name__)

# --- History tracking ------------------------------------------------------
# A search hit adds its MAC to a watchlist; onu_history_collect.py (cron, every
# 5 min) then polls the watched MACs going forward for optical signal + WAN
# traffic, so a repeat search shows a trend, not just the live snapshot.
DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "history.db")
HISTORY_RETENTION_DAYS = 7


def db():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    # WAL lets a reader (e.g. this web process) proceed while the collector
    # cron holds a write lock, instead of the two blocking each other —
    # belt-and-braces alongside keeping the collector's transactions short.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def init_db():
    with db() as c:
        c.execute(
            """CREATE TABLE IF NOT EXISTS watchlist (
                mac TEXT PRIMARY KEY, ip TEXT, port TEXT, pon TEXT, onu TEXT,
                label TEXT, location TEXT, added_ts REAL, wan_username TEXT)"""
        )
        c.execute(
            """CREATE TABLE IF NOT EXISTS onu_history (
                mac TEXT, ts REAL,
                rx_dbm REAL, tx_dbm REAL, up_kbps REAL, down_kbps REAL)"""
        )
        c.execute("CREATE INDEX IF NOT EXISTS idx_onu_history_mac_ts ON onu_history(mac, ts)")
        c.execute(
            """CREATE TABLE IF NOT EXISTS octet_cache (
                mac TEXT PRIMARY KEY, started TEXT, nas_ip TEXT, ifindex INTEGER,
                up_octets INTEGER, down_octets INTEGER, ts REAL)"""
        )
        # Migration for a DB created before nas_ip/ifindex existed (direct-SNMP
        # PPPoE traffic replaced the dead RADIUS-octet approach, 2026-09-10).
        existing_cols = {row[1] for row in c.execute("PRAGMA table_info(octet_cache)")}
        for col in ("nas_ip", "ifindex"):
            if col not in existing_cols:
                col_type = "TEXT" if col == "nas_ip" else "INTEGER"
                c.execute(f"ALTER TABLE octet_cache ADD COLUMN {col} {col_type}")
        watchlist_cols = {row[1] for row in c.execute("PRAGMA table_info(watchlist)")}
        if "wan_username" not in watchlist_cols:
            c.execute("ALTER TABLE watchlist ADD COLUMN wan_username TEXT")
        if "last_seen" not in watchlist_cols:
            # Fleet-wide auto-discovery (2026-09-10): last_seen marks a mac as
            # currently online per the last full-fleet sweep, so the collector
            # can skip macs that dropped offline instead of polling them forever.
            c.execute("ALTER TABLE watchlist ADD COLUMN last_seen REAL")


init_db()


_DBM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _parse_dbm(v):
    """Optical fields come back like '-21.16dBm' or '-21.16' or None/'N/A'."""
    if v in (None, "", "N/A"):
        return None
    m = _DBM_RE.search(str(v))
    return float(m.group(0)) if m else None


def watch_onu(mac, ip, port, pon, onu, label, location, rx_dbm=None, tx_dbm=None, wan_username=None):
    now = time.time()
    with db() as c:
        c.execute(
            """INSERT INTO watchlist(mac, ip, port, pon, onu, label, location, added_ts, wan_username, last_seen)
               VALUES(?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(mac) DO UPDATE SET
                 ip=excluded.ip, port=excluded.port, pon=excluded.pon, onu=excluded.onu,
                 label=excluded.label, location=excluded.location,
                 wan_username=COALESCE(excluded.wan_username, watchlist.wan_username),
                 last_seen=excluded.last_seen""",
            (mac, ip, port, pon, onu, label, location, now, wan_username, now),
        )
        # Seed the very first history point from the signal the live search
        # already fetched, so the chart shows something immediately instead
        # of making the user wait for the next 5-min cron tick. Traffic still
        # needs two cron-sampled octet readings to diff, so it stays null here.
        c.execute(
            "INSERT INTO onu_history(mac, ts, rx_dbm, tx_dbm, up_kbps, down_kbps) VALUES(?,?,?,?,NULL,NULL)",
            (mac, now, _parse_dbm(rx_dbm), _parse_dbm(tx_dbm)),
        )


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def normalize_mac(raw):
    """Accepts any of aa:bb:cc:dd:ee:ff / aa-bb-... / aabb.ccdd.eeff / aabbccddeeff."""
    hexonly = re.sub(r"[^0-9a-fA-F]", "", raw)
    if len(hexonly) != 12:
        return None
    hexonly = hexonly.lower()
    return ":".join(hexonly[i:i + 2] for i in range(0, 12, 2))


def creds_for(ip, creds_cfg):
    ov = creds_cfg.get("overrides", {}).get(ip)
    if ov:
        return ov["user"], ov["pass"]
    d = creds_cfg["default"]
    return d["user"], d["pass"]


ROW_RE = re.compile(
    r"<td>(\d+)</td>\s*<td>(\d+)</td>\s*<td>([0-9a-fA-F:]{17})</td>\s*"
    r"<td>(\w+)</td>\s*<td>(\d+):(\d+)</td>",
    re.IGNORECASE,
)

# Two OLT web-UI firmware families seen across the fleet, differing only in the
# action-page name prefix ("onu*" vs "gpononu*", the latter also wants slotid=0).
# Try classic first (most of the fleet); fall back to gpon if its status page 404s.
FIRMWARE_PREFIXES = ["onu", "gpononu"]

DETAIL_FIELDS = {
    "sw_version": "Main software version",
    "vendor_id": "Vendor ID:",
    "onu_hw_version": "Version:",
    "sn": "SN:",
    "admin_status": "Admin status:",
    "operate_status": "Operate status:",
    "equipment_id": "Equipment ID:",
    "model": "Model:",
    "onu_type": "ONU type:",
    "sys_uptime": "SysUpTime:",
}
DESC_RE = re.compile(r"id='onu_description'[^>]*value=\"([^\"]*)\"")

# newer firmware splits Rx into ONU-side / OLT-side readings; ONU-side (appears
# first) is the one that matches the classic single "Rx optical level" field.
OPTICAL_FIELDS = {
    "rx_power_dbm": "Rx optical level",
    "tx_power_dbm": "Tx optical level",
    "distance": "Distance",
    "temperature": "Temperature",
    "voltage": "Power feed voltage",
    "bias_current": "Laser bias current",
    "response_time": "ONU response time",
}

IPHOST_FIELDS = ["wan_desc", "wan_ip_mode", "wan_ip", "wan_mask", "wan_gateway", "wan_dns1", "wan_dns2", "wan_vlan"]


def _kv(text, label):
    """Label cell may be plain text or wrapped as <font data-i18N-text=...>Label</font>
    (optionally with a "(ONU)"/"(OLT)" suffix inside it), with the trailing colon
    either inside or outside that wrapper."""
    label = label.rstrip(":")
    m = re.search(re.escape(label) + r"(?:\([^)]*\))?(?:</font>)?:?\s*</td>\s*<td>([^<]*)</td>", text)
    return m.group(1).strip() or None if m else None


def _params(prefix, pon, onu, extra=None):
    p = {"who": 100, "onuid": onu, "ponid": pon}
    if prefix == "gpononu":
        p["slotid"] = 0
    if extra:
        p.update(extra)
    return p


def fetch_onu_detail(sess, ip, prefix, pon, onu):
    try:
        r = sess.get(
            f"https://{ip}/action/{prefix}detail.html",
            params=_params(prefix, pon, onu),
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
    except requests.exceptions.RequestException:
        return {}
    text = r.text
    out = {k: _kv(text, label) for k, label in DETAIL_FIELDS.items()}
    m = DESC_RE.search(text)
    out["description"] = m.group(1) if m else None
    return out


def fetch_onu_optical(sess, ip, prefix, pon, onu):
    try:
        r = sess.get(
            f"https://{ip}/action/{prefix}optical.html",
            params=_params(prefix, pon, onu),
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
    except requests.exceptions.RequestException:
        return {}
    text = r.text
    return {k: _kv(text, label) for k, label in OPTICAL_FIELDS.items()}


IPHOST_ROW_RE = re.compile(
    r"<table[^>]*>\s*<tr>\s*<td[^>]*>(?:(?:(?!</td>).)*?Iphost ID(?:(?!</td>).)*?)</td>"
    r"\s*<td[^>]*>(?:(?:(?!</td>).)*?Desc(?:(?!</td>).)*?)</td>.*?</tr>"
    r"(<tr>.*?</tr>)",
    re.IGNORECASE | re.DOTALL,
)
TD_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.IGNORECASE | re.DOTALL)
TAG_RE = re.compile(r"<[^>]*>")


WAN_TABLE_RE = re.compile(r"WAN Connect Table.*?<table[^>]*>(.*?)</table>", re.IGNORECASE | re.DOTALL)
MAC_RE = re.compile(r"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$", re.IGNORECASE)

# Cell values in the WAN Connect Table row that identify what column they are,
# independent of position — different firmware builds insert extra columns
# (IP Version, MAC Address) ahead of "Configuration Information", so matching
# by position breaks on some OLTs. Values are matched case-insensitively.
WAN_CELL_TAGS = {
    "route": "wan_mode", "bridge": "wan_mode",
    "connected": "wan_status", "disconnected": "wan_status", "up": "wan_status", "down": "wan_status",
    "internet": "wan_service_mode", "other": "wan_service_mode", "tr069": "wan_service_mode",
    "tr069_internet": "wan_service_mode", "voip": "wan_service_mode",
    "ipv4": "wan_ip_version", "ipv6": "wan_ip_version", "ipv4/ipv6": "wan_ip_version", "ipv4v6": "wan_ip_version",
}


def _wan_info_kv(info, label):
    """Values here (IPs, enable/disable, numbers, usernames) never contain
    whitespace, but the key:value pairs are inconsistently comma- or
    <br>-separated (already collapsed to spaces by the caller), so stop the
    value at the first comma OR whitespace, whichever comes first."""
    m = re.search(re.escape(label) + r":([^,\s]*)", info, re.IGNORECASE)
    return m.group(1).strip() or None if m else None


def _parse_wan_config_info(info):
    """The last cell of the WAN Connect Table row is a free-text blob like
    'QoS Enable:disable,MTU:1492,Connect Mode:PPPOE,PPPOE Proxy:disable,
    UserName:x,pwd:y,serverName:,mode:auto,Dynamic IP:a.b.c.d,Mask:...,
    Gateway:...,DNS Master:...,DNS Slave:...,Nat:enable,VLAN Mode:...'
    — key names and which keys are present vary by firmware/connect mode."""
    out = {
        "wan_username": _wan_info_kv(info, "UserName"),
        "wan_has_password": bool(re.search(r"pwd:[^,]+", info, re.IGNORECASE)),
        "wan_nat": _wan_info_kv(info, "Nat"),
        "wan_mtu": _wan_info_kv(info, "MTU"),
        "wan_connect_mode": _wan_info_kv(info, "Connect Mode"),
        "wan_ip": _wan_info_kv(info, "Dynamic IP") or _wan_info_kv(info, "Static IP") or _wan_info_kv(info, "IP Address"),
        "wan_mask": _wan_info_kv(info, "Mask"),
        "wan_gateway": _wan_info_kv(info, "Gateway"),
        "wan_dns1": _wan_info_kv(info, "DNS Master") or _wan_info_kv(info, "Master DNS"),
        "wan_dns2": _wan_info_kv(info, "DNS Slave") or _wan_info_kv(info, "Slave DNS"),
    }
    vlan_m = re.search(r"vlan (?:id )?(\d+)(?:\s*pri\s*(\d+))?", info, re.IGNORECASE)
    if vlan_m:
        out["wan_vlan"] = vlan_m.group(1)
        out["wan_vlan_pri"] = vlan_m.group(2)
    return {k: v for k, v in out.items() if v}


def fetch_onu_wan_route(sess, ip, prefix, pon, onu):
    """Reads the live per-ONU WAN Connect Table (route/PPPoE/bridge mode) —
    this is what the OLT actually provisions for home-gateway ONUs (username,
    VLAN, NAT, MTU, connect status, and for PPPoE the live-assigned IP/mask/
    gateway/DNS), distinct from the pure-bridge Iphost table."""
    try:
        r = sess.get(
            f"https://{ip}/action/{prefix}Wan.html",
            params=_params(prefix, pon, onu),
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
    except requests.exceptions.RequestException:
        return {}
    m = WAN_TABLE_RE.search(r.text)
    if not m:
        return {}
    rows = re.findall(r"<tr>(.*?)</tr>", m.group(1), re.IGNORECASE | re.DOTALL)
    if len(rows) < 2:
        return {}
    cells = [TAG_RE.sub(" ", c).strip() for c in TD_RE.findall(rows[1])]
    if len(cells) < 2 or not cells[0].isdigit():
        return {}
    out = {"wan_index": cells[0]}
    for cell in cells[1:-1]:
        tag = WAN_CELL_TAGS.get(cell.lower())
        if tag:
            out[tag] = cell
        elif MAC_RE.match(cell):
            out["wan_mac"] = cell.lower()
    out.update(_parse_wan_config_info(cells[-1]))
    return out


def fetch_onu_wan_bridge(sess, ip, prefix, pon, onu):
    """Reads the ONU's OLT-provisioned bridge-mode Iphost table (static-ip/DHCP
    handed out directly on a bridged LAN port, no router/PPPoE involved)."""
    try:
        r = sess.get(
            f"https://{ip}/action/{prefix}IphostCfg.html",
            params=_params(prefix, pon, onu),
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
    except requests.exceptions.RequestException:
        return {}
    m = IPHOST_ROW_RE.search(r.text)
    if not m:
        return {}
    cells = [TAG_RE.sub("", c).strip() for c in TD_RE.findall(m.group(1))]
    if len(cells) < 9 or not cells[1]:
        return {}
    # Iphost ID, Desc, IP Mode, IP Address, Mask, Gateway, DNS1, DNS2, VLAN, Priority, Action
    keys = ["wan_desc", "wan_ip_mode", "wan_ip", "wan_mask", "wan_gateway", "wan_dns1", "wan_dns2", "wan_vlan"]
    return dict(zip(keys, cells[1:9]))


def fetch_onu_wan(sess, ip, prefix, pon, onu):
    """Neither table populates for an ONU the OLT doesn't manage the WAN of at
    all (e.g. it's fully self-configured outside any OLT-pushed profile) —
    that's a real absence of OLT-side visibility, not a fetch failure."""
    route = fetch_onu_wan_route(sess, ip, prefix, pon, onu)
    if route:
        return route
    return fetch_onu_wan_bridge(sess, ip, prefix, pon, onu)


def fetch_radius_session(mac):
    """Fallback WAN lookup for ONUs the OLT never provisioned WAN for (most
    non-VSOL brands, fleet-wide — see project notes). PPPoE auth/accounting
    goes through MikroTik User Manager regardless of ONU brand, and its
    session log keys on calling-station-id (the ONU's own MAC), so this finds
    live username/IP/status even when the OLT's own tables are empty.
    Read-only: a 'select' query, no writes. Returns None on any failure."""
    # Disabled 2026-09-17: the MikroTik read-only account this used
    # (config/mikrotik.json) was disabled fleet-wide for security after a
    # past outage traced to standing MikroTik API credentials. Never
    # re-enable without a fresh, scoped account and the user's OK.
    return None


# Aggregate PON-port octet counter, read via the OLT's vendor SNMP MIB
# (Vsol-chipset OID tree, seen on both VSOL- and whitebox-branded OLTs).
# This is traffic for the whole PON port (every ONU on it combined) — GPON
# doesn't expose a per-ONU live bitrate without deeper OMCI/GEM-port stats,
# which this OLT's SNMP agent doesn't carry.
PON_OCTETS_OID = "1.3.6.1.4.1.37950.1.1.5.10.1.2.2.1.3"
SNMP_SAMPLE_GAP_S = 2.5


async def _snmp_get_int(ip, community, port, oid):
    engine = SnmpEngine()
    transport = await UdpTransportTarget.create((ip, port), timeout=3, retries=0)
    auth = CommunityData(community, mpModel=1)
    errorIndication, errorStatus, _errorIndex, varBinds = await get_cmd(
        engine, auth, transport, ContextData(), ObjectType(ObjectIdentity(oid)),
    )
    if errorIndication or errorStatus:
        return None
    for _name, val in varBinds:
        try:
            return int(val)
        except (TypeError, ValueError):
            return None
    return None


def fetch_pon_traffic(ip, pon):
    """Live aggregate throughput for a PON port, sampled twice a couple
    seconds apart and converted to Mbps. Read-only SNMP GETs. Returns {} if
    the OLT has no SNMP agent reachable or the community string is wrong —
    this is a nice-to-have on top of the search, never a hard requirement."""
    try:
        snmp_cfg = load_json(SNMP_PATH)
    except (OSError, json.JSONDecodeError):
        return {}
    community = snmp_cfg.get("community", "public")
    port = snmp_cfg.get("port", 161)
    oid = f"{PON_OCTETS_OID}.{pon}"

    # Some PON ports on this fleet report this counter pegged at INT32_MAX
    # (2**31 - 1) — a stuck/saturated counter, not "zero traffic". Treat that
    # value, and any non-positive delta, as no reading rather than 0 Mbps,
    # since either would silently lie about the port being idle.
    STUCK_VALUE = 2**31 - 1

    try:
        t0 = asyncio.run(_snmp_get_int(ip, community, port, oid))
        if t0 is None or t0 == STUCK_VALUE:
            return {}
        time.sleep(SNMP_SAMPLE_GAP_S)
        t1 = asyncio.run(_snmp_get_int(ip, community, port, oid))
        if t1 is None or t1 == STUCK_VALUE or t1 <= t0:
            return {}
    except Exception:  # noqa: BLE001 — SNMP-side hiccup just means no traffic reading
        return {}

    delta_bytes = t1 - t0
    mbps = round((delta_bytes * 8) / (SNMP_SAMPLE_GAP_S * 1_000_000), 2)
    return {"pon_traffic_mbps": mbps, "pon_traffic_note": f"aggregate for PON {pon}, all ONUs, sampled over {SNMP_SAMPLE_GAP_S}s"}


def _first_data_table_rows(text):
    """Grabs the header + data rows of the first bordered table on a config
    sub-page (Tcont/Gemport/Service Port etc). These pages always render the
    live table first, then a separate "Add new" form table further down."""
    m = re.search(r'<table border="1"[^>]*>(.*?)</table>', text, re.IGNORECASE | re.DOTALL)
    if not m:
        return [], []
    trs = re.findall(r"<tr>(.*?)</tr>", m.group(1), re.IGNORECASE | re.DOTALL)
    if not trs:
        return [], []
    header = [TAG_RE.sub("", c).strip().lower() for c in TD_RE.findall(trs[0])]
    rows = [[TAG_RE.sub(" ", c).strip() for c in TD_RE.findall(tr)] for tr in trs[1:]]
    return header, rows


def _rows_to_dicts(header, rows, key_map):
    out = []
    for cells in rows:
        d = {key_map[h]: v for h, v in zip(header, cells) if h in key_map and v}
        if d:
            out.append(d)
    return out


TCONT_KEYS = {"tcont id": "tcont_id", "name": "name", "dba profile": "dba_profile"}
GEMPORT_KEYS = {"gemport id": "gemport_id", "name": "name", "tcont": "tcont_id", "cos": "cos", "downstream": "downstream", "state": "state"}
SERVICEPORT_KEYS = {
    "service port": "service_port", "gemport id": "gemport_id", "vlan": "vlan", "svlan": "svlan",
    "mode": "mode", "enable": "enable", "description": "description",
}


def fetch_onu_config(sess, ip, prefix, pon, onu):
    """Pulls the ONU's provisioning config (Tcont/Gemport/Service-Port) —
    the same underlying data a ZTE OLT's `show running-config` would print,
    just read through this OLT's web pages instead of a CLI."""
    pages = {
        "tcont": (f"{prefix}Tcont.html", TCONT_KEYS),
        "gemport": (f"{prefix}Gemport.html", GEMPORT_KEYS),
        "service_port": (f"{prefix}ServicePort.html", SERVICEPORT_KEYS),
    }
    out = {}
    for key, (page, key_map) in pages.items():
        try:
            r = sess.get(
                f"https://{ip}/action/{page}",
                params=_params(prefix, pon, onu),
                timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
            )
        except requests.exceptions.RequestException:
            out[key] = []
            continue
        header, rows = _first_data_table_rows(r.text)
        out[key] = _rows_to_dicts(header, rows, key_map)
    return out


def render_running_config(pon, onu, description, cfg, detail=None):
    lines = []
    if detail:
        model = detail.get("model") if detail.get("model") not in (None, "N/A") else detail.get("equipment_id")
        lines += [
            "! ONU Details",
            f"! vendor {detail.get('vendor_id') or '?'}  hw-version {detail.get('onu_hw_version') or '?'}"
            f"  model {model or '?'}  type {detail.get('onu_type') or '?'}",
            f"! serial {detail.get('sn') or '?'}  sw-version {detail.get('sw_version') or '?'}"
            f"  admin/oper {detail.get('admin_status') or '?'}/{detail.get('operate_status') or '?'}",
            "!",
        ]
    lines.append(f"interface gpon-onu_{pon}:{onu}")
    if description:
        lines.append(f"  description {description}")
    for t in cfg.get("tcont", []):
        lines.append(f"  tcont {t.get('tcont_id', '?')} profile {t.get('dba_profile', '?')}")
    for g in cfg.get("gemport", []):
        lines.append(f"  gemport {g.get('gemport_id', '?')} tcont {g.get('tcont_id', '?')}")
    for sp in cfg.get("service_port", []):
        lines.append(f"  service-port {sp.get('service_port', '?')} vport {sp.get('gemport_id', '?')} vlan {sp.get('vlan', '?')}")

    if detail and detail.get("wan_source") == "radius":
        lines += [
            "!",
            "! ONU WAN (via RADIUS accounting — not OLT-provisioned)",
            f"! status {detail.get('wan_status') or '?'}  ip {detail.get('wan_ip') or '—'}",
            f"! pppoe-user {detail.get('wan_username') or '—'}",
            f"! session-started {detail.get('wan_started') or '—'}  uptime {detail.get('wan_uptime') or '—'}"
            f"  nas-port {detail.get('wan_nas_port') or '—'}",
        ]
    elif detail and (detail.get("wan_mode") or detail.get("wan_status") or detail.get("wan_ip") or detail.get("wan_ip_mode")):
        dns = detail.get("wan_dns1") or "—"
        if detail.get("wan_dns2"):
            dns += f" / {detail['wan_dns2']}"
        vlan_pri = f"{detail.get('wan_vlan') or '—'} / {detail.get('wan_vlan_pri') or '—'}"
        password = "•••••• (set)" if detail.get("wan_has_password") else "—"
        lines += [
            "!",
            "! ONU WAN",
            f"! status {detail.get('wan_status') or detail.get('wan_ip_mode') or '?'}"
            f"  mode {detail.get('wan_mode') or '?'} / {detail.get('wan_connect_mode') or detail.get('wan_service_mode') or '?'}",
            f"! ip {detail.get('wan_ip') or '—'}"
            f"{' (via RADIUS)' if detail.get('wan_ip_source') == 'radius' else ''}"
            f"  gateway {detail.get('wan_gateway') or '—'}  dns {dns}",
            f"! pppoe-user {detail.get('wan_username') or '—'}  password {password}",
            f"! vlan/pri {vlan_pri}  nat {detail.get('wan_nat') or '—'}"
            f"  mtu {detail.get('wan_mtu') or '—'}  uplink-mac {detail.get('wan_mac') or '—'}",
        ]
    else:
        lines += [
            "!",
            "! ONU WAN: no data (not OLT-provisioned, and no matching RADIUS session found)",
        ]

    return "\n".join(lines)


ONU_ROW_RE_TMPL = (
    r"<td>GPON0/{pon}:{onu}</td>\s*<td><font color='[^']*'>(?:<font[^>]*>)?([^<]*)(?:</font>)?</font></td>"
    r"<td>([^<]*)</td><td>([^<]*)</td><td>[^<]*</td><td>[^<]*</td>\s*<td>([^<]*)</td>"
)

# Generic (any pon/onu) version of the same row shape, used to scan a whole
# PON's ONU table for a serial-number match instead of one known pon:onu.
ONU_AUTH_ROW_RE = re.compile(
    r"<td>GPON0/(\d+):(\d+)</td>\s*<td><font color='[^']*'>(?:<font[^>]*>)?([^<]*)(?:</font>)?</font></td>"
    r"<td>([^<]*)</td><td>([^<]*)</td><td>[^<]*</td><td>[^<]*</td>\s*<td>([^<]*)</td>",
    re.IGNORECASE,
)
MAX_PON_PROBE = 8  # safe upper bound: requesting a PON beyond an OLT's real port count just returns an empty table


def _sn_suffix(s):
    """The 8 hex digits are the ONU's real unique serial; the 4-char vendor
    prefix in front can legitimately differ between pages for the same
    physical device (e.g. onudetail.html says 'VSOL006146b5' while
    onuauthinfo.html's Info column says 'GPON006146b5' for that same ONU) —
    so match on this suffix, not the full string."""
    return re.sub(r"[^0-9a-fA-F]", "", s)[-8:].lower()


def find_onu_by_serial(sess, host, target_sn):
    """Scans every PON's ONU table (Info column carries the serial) across
    both firmware variants, looking for a match. Returns
    (pon, onu, description, model) or None."""
    target_sn = _sn_suffix(target_sn)
    for prefix in FIRMWARE_PREFIXES:
        try:
            probe = sess.get(
                f"https://{host}/action/{prefix}authinfo.html",
                params={"who": 100, "select": 1, "authmode": 0},
                timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
            )
        except requests.exceptions.RequestException:
            continue
        if "ONU ID" not in probe.text:
            continue  # wrong firmware prefix for this OLT

        for pon in range(1, MAX_PON_PROBE + 1):
            if pon == 1:
                text = probe.text
            else:
                try:
                    r = sess.get(
                        f"https://{host}/action/{prefix}authinfo.html",
                        params={"who": 100, "select": pon, "authmode": 0},
                        timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
                    )
                except requests.exceptions.RequestException:
                    continue
                text = r.text
            for row_pon, row_onu, _status, description, model, serial in ONU_AUTH_ROW_RE.findall(text):
                if _sn_suffix(serial) == target_sn:
                    return row_pon, row_onu, description.strip(), model.strip()
        return None  # right firmware, scanned every PON, genuinely not here
    return None


def fetch_onu_status(sess, ip, prefix, pon, onu):
    """Returns (fields, page_valid). page_valid is False when this firmware
    prefix doesn't apply here (404 / no ONU table), so the caller can try the
    other firmware's action-page naming instead."""
    try:
        r = sess.get(
            f"https://{ip}/action/{prefix}authinfo.html",
            params={"who": 100, "select": pon, "authmode": 0},
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
    except requests.exceptions.RequestException:
        return {}, False
    if "ONU ID" not in r.text:
        return {}, False
    m = re.search(ONU_ROW_RE_TMPL.format(pon=pon, onu=onu), r.text)
    if not m:
        return {}, True
    online_status, description, model, serial = m.groups()
    return {
        "online_status": online_status.strip(),
        "auth_description": description.strip(),
        "auth_model": model.strip(),
        "auth_serial": serial.strip(),
    }, True


def fetch_onu_bundle(sess, ip, pon, onu, mac=None):
    out = {}
    prefix = FIRMWARE_PREFIXES[0]
    for i, candidate in enumerate(FIRMWARE_PREFIXES):
        status, valid = fetch_onu_status(sess, ip, candidate, pon, onu)
        if valid:
            prefix = candidate
            out.update(status)
            break
        if i == len(FIRMWARE_PREFIXES) - 1:
            prefix = candidate  # nothing validated; still try full fetch with last prefix
    out.update(fetch_onu_detail(sess, ip, prefix, pon, onu))
    out.update(fetch_onu_optical(sess, ip, prefix, pon, onu))
    wan = fetch_onu_wan(sess, ip, prefix, pon, onu)
    if mac:
        if not wan:
            wan = fetch_radius_session(mac) or {}
        elif not wan.get("wan_ip"):
            # OLT knows the session is up (e.g. PPPoE "Connected") but never
            # recorded the live-assigned IP — RADIUS accounting has it.
            radius = fetch_radius_session(mac)
            if radius and radius.get("wan_ip"):
                wan["wan_ip"] = radius["wan_ip"]
                wan.setdefault("wan_started", radius.get("wan_started"))
                wan.setdefault("wan_uptime", radius.get("wan_uptime"))
                wan["wan_ip_source"] = "radius"
    out.update(wan)
    cfg = fetch_onu_config(sess, ip, prefix, pon, onu)
    out["onu_config"] = cfg
    out["running_config"] = render_running_config(pon, onu, out.get("description"), cfg, detail=out)
    return out


# Third firmware family seen on a couple of OLTs: a Vue SPA frontend backed by
# a clean JSON API (no ".html" pages, no "mainFrame" login marker at all).
# Its data endpoints (unlike its config/"set" endpoints) turned out to need
# no session/auth beyond a valid login having happened once for that IP.
SPA_DETAIL_PROPS = {
    "Description": "description",
    "Main Software Version": "sw_version",
    "VendorID": "vendor_id",
    "Version": "onu_hw_version",
    "SN": "sn",
    "Admin Status": "admin_status",
    "Operate Status": "operate_status",
    "Equipment ID": "equipment_id",
    "Model": "model",
    "System Uptime": "sys_uptime",
}
SPA_OPTICAL_PROPS = {
    "Rx Optical Level(ONU)": "rx_power_dbm",
    "Tx Optical Level": "tx_power_dbm",
    "Distance": "distance",
    "Temperature": "temperature",
    "Power Feed Voltage": "voltage",
    "Laser Bias Current": "bias_current",
    "ONU Response Time": "response_time",
}


def spa_login(sess, host, user, pw):
    try:
        r = sess.post(
            f"https://{host}/action/main",
            data={"user": user, "pass": pw, "verification_code": "", "button": "Login", "who": 100},
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
        return r.json().get("data", {}).get("result") == "SUCCESS"
    except (requests.exceptions.RequestException, ValueError):
        return False


def _spa_get_json(sess, host, path, params):
    try:
        r = sess.get(f"https://{host}/action/{path}", params=params, timeout=(CONNECT_TIMEOUT, READ_TIMEOUT))
        return r.json().get("data", {})
    except (requests.exceptions.RequestException, ValueError):
        return {}


def _spa_props(sess, host, path, pon, onu, list_key, prop_map):
    data = _spa_get_json(sess, host, path, {"ponid": pon, "onuid": onu})
    props = {p.get("property"): p.get("value") for p in data.get(list_key, [])}
    return {key: props[label] for label, key in prop_map.items() if label in props}


def fetch_spa_onu_bundle(sess, host, pon, onu, mac=None):
    out = _spa_props(sess, host, "gpononudetail", pon, onu, "onu_detail_info", SPA_DETAIL_PROPS)
    out.update(_spa_props(sess, host, "gpononuoptical", pon, onu, "onu_optical_info", SPA_OPTICAL_PROPS))

    status = _spa_get_json(sess, host, "gpononustatusinfo", {"ponid": pon, "onuid": onu})
    rows = status.get("onuStatus_list", [])
    row = next((r for r in rows if r.get("onu_id", "").endswith(f":{onu}")), rows[0] if rows else {})
    if row:
        out["online_status"] = "Online" if row.get("phase_state") == "working" else "Offline"

    auth = _spa_get_json(sess, host, "gpononuauthinfo", {"portid": pon, "slotid": 0})
    auth_rows = auth.get("onuAuth_list", [])
    auth_row = next((r for r in auth_rows if r.get("onuid") == str(onu)), None)
    if auth_row:
        out["auth_description"] = auth_row.get("description")
        out["auth_model"] = auth_row.get("model")
        out["auth_serial"] = auth_row.get("info")

    tcont_data = _spa_get_json(sess, host, "gpononuTcont", {"ponid": pon, "onuid": onu})
    gem_data = _spa_get_json(sess, host, "gpononuGemport", {"ponid": pon, "onuid": onu})
    sp_data = _spa_get_json(sess, host, "gpononuServicePort", {"ponid": pon, "onuid": onu})
    cfg = {
        "tcont": [
            {"tcont_id": t.get("tcontid"), "name": t.get("tcontname"), "dba_profile": t.get("dbaprofile")}
            for t in tcont_data.get("tcont_list", [])
        ],
        "gemport": [
            {"gemport_id": g.get("gemid"), "name": g.get("gemname"), "tcont_id": g.get("tcontid")}
            for g in gem_data.get("gemport_list", [])
        ],
        "service_port": [
            {"service_port": s.get("servicePort"), "gemport_id": s.get("gemport"), "vlan": s.get("vlan")}
            for s in sp_data.get("service_port_list", [])
        ],
    }
    out["onu_config"] = cfg

    if mac:
        wan = fetch_radius_session(mac)
        if wan:
            out.update(wan)

    out["running_config"] = render_running_config(pon, onu, out.get("description"), cfg, detail=out)
    return out


def find_onu_by_serial_spa(sess, host, target_sn):
    target_sn = _sn_suffix(target_sn)
    for pon in range(1, MAX_PON_PROBE + 1):
        auth = _spa_get_json(sess, host, "gpononuauthinfo", {"portid": pon, "slotid": 0})
        for row in auth.get("onuAuth_list", []):
            if _sn_suffix(row.get("info", "")) == target_sn:
                return row.get("pon_id", str(pon)), row.get("onuid"), row.get("description"), row.get("model")
    return None


def search_olt_spa_by_sn(olt, target_sn, creds_cfg, sess, host):
    ip = olt["ip"]
    result = {
        "ip": ip,
        "label": olt["label"],
        "location": olt["location"],
        "status": "not_found",
        "detail": None,
        "pon": None,
        "onu": None,
        "vlan": None,
        "port": olt.get("port"),
    }
    user, pw = creds_for(ip, creds_cfg)
    if not spa_login(sess, host, user, pw):
        result["status"] = "login_failed"
        return result

    found = find_onu_by_serial_spa(sess, host, target_sn)
    if not found:
        result["status"] = "not_found"
        return result

    pon, onu, description, model = found
    result["status"] = "found"
    result["pon"] = pon
    result["onu"] = onu
    result["auth_description"] = description
    result["auth_model"] = model

    data = _spa_get_json(sess, host, "macinfoPon", {})
    rows = [r for r in data.get("pon_max_list", []) if r.get("ponOnu") == f"{pon}:{onu}"]
    result["onu_macs"] = [
        {"vlan": r.get("vlanId"), "mac": r.get("mac", "").lower(), "mac_type": r.get("type")} for r in rows
    ]
    client_mac = rows[0]["mac"].lower() if rows else None
    if rows:
        result["vlan"] = rows[0].get("vlanId")

    result.update(fetch_spa_onu_bundle(sess, host, pon, onu, mac=client_mac))
    result.update(fetch_pon_traffic(ip, pon))
    return result


def search_olt_spa(olt, target_mac, creds_cfg, sess, host):
    """Called from search_olt as a fallback once the classic form-login has
    failed — this firmware family (Vue SPA + JSON API) never returns the
    'mainFrame' marker classic pages use, so it always looked like a bad
    password even when the creds were fine."""
    ip = olt["ip"]
    result = {
        "ip": ip,
        "label": olt["label"],
        "location": olt["location"],
        "status": "not_found",
        "detail": None,
        "pon": None,
        "onu": None,
        "vlan": None,
        "port": olt.get("port"),
    }
    user, pw = creds_for(ip, creds_cfg)
    if not spa_login(sess, host, user, pw):
        result["status"] = "login_failed"
        return result

    data = _spa_get_json(sess, host, "macinfoPon", {})
    rows = data.get("pon_max_list", [])
    match = next((r for r in rows if r.get("mac", "").lower() == target_mac), None)
    if not match:
        result["status"] = "not_found"
        return result

    pon, onu = match["ponOnu"].split(":")
    result["status"] = "found"
    result["pon"] = pon
    result["onu"] = onu
    result["vlan"] = match.get("vlanId")
    result["mac_type"] = match.get("type")
    result.update(fetch_spa_onu_bundle(sess, host, pon, onu, mac=target_mac))
    result.update(fetch_pon_traffic(ip, pon))
    result["onu_macs"] = [
        {"vlan": r.get("vlanId"), "mac": r.get("mac", "").lower(), "mac_type": r.get("type")}
        for r in rows
        if r.get("ponOnu") == match["ponOnu"]
    ]
    return result


def search_olt(olt, target_mac, creds_cfg):
    ip = olt["ip"]
    host = f"{ip}:{olt['port']}" if olt.get("port") else ip
    label = olt["label"] or olt["location"] or ip
    result = {
        "ip": ip,
        "label": olt["label"],
        "location": olt["location"],
        "status": "not_found",
        "detail": None,
        "pon": None,
        "onu": None,
        "vlan": None,
        "port": olt.get("port"),
    }

    dead = load_json(CREDS_PATH).get("known_dead", {})
    if ip in dead:
        result["status"] = "skipped"
        result["detail"] = dead[ip]
        return result

    user, pw = creds_for(ip, creds_cfg)
    sess = requests.Session()
    sess.verify = False
    try:
        login = sess.post(
            f"https://{host}/action/main.html",
            data={"user": user, "pass": pw, "who": 100},
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
        if "mainFrame" not in login.text:
            return search_olt_spa(olt, target_mac, creds_cfg, sess, host)

        page = sess.get(
            f"https://{host}/action/macinfoPon.html",
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
        text = page.text
        if target_mac not in text.lower():
            result["status"] = "not_found"
            return result

        for m in ROW_RE.finditer(text):
            _idx, vlan, mac, mtype, pon, onu = m.groups()
            if mac.lower() == target_mac:
                result["status"] = "found"
                result["pon"] = pon
                result["onu"] = onu
                result["vlan"] = vlan
                result["mac_type"] = mtype
                result.update(fetch_onu_bundle(sess, host, pon, onu, mac=mac))
                result.update(fetch_pon_traffic(ip, pon))
                result["onu_macs"] = [
                    {"vlan": ov, "mac": omac.lower(), "mac_type": ot}
                    for _oi, ov, omac, ot, opon, oonu in ROW_RE.findall(text)
                    if opon == pon and oonu == onu
                ]
                return result

        # MAC string appeared but row regex didn't parse it (page layout drift)
        result["status"] = "found_unparsed"
        return result

    except requests.exceptions.ConnectTimeout:
        result["status"] = "unreachable"
        result["detail"] = "connect timeout"
    except requests.exceptions.ReadTimeout:
        result["status"] = "timeout"
        result["detail"] = "read timeout"
    except requests.exceptions.SSLError as e:
        result["status"] = "error"
        result["detail"] = f"TLS error: {e}"
    except requests.exceptions.ConnectionError:
        result["status"] = "unreachable"
        result["detail"] = "connection refused / no route"
    except Exception as e:  # noqa: BLE001
        result["status"] = "error"
        result["detail"] = str(e)
    return result


def search_olt_by_sn(olt, target_sn, creds_cfg):
    ip = olt["ip"]
    host = f"{ip}:{olt['port']}" if olt.get("port") else ip
    result = {
        "ip": ip,
        "label": olt["label"],
        "location": olt["location"],
        "status": "not_found",
        "detail": None,
        "pon": None,
        "onu": None,
        "vlan": None,
        "port": olt.get("port"),
    }

    dead = load_json(CREDS_PATH).get("known_dead", {})
    if ip in dead:
        result["status"] = "skipped"
        result["detail"] = dead[ip]
        return result

    user, pw = creds_for(ip, creds_cfg)
    sess = requests.Session()
    sess.verify = False
    try:
        login = sess.post(
            f"https://{host}/action/main.html",
            data={"user": user, "pass": pw, "who": 100},
            timeout=(CONNECT_TIMEOUT, READ_TIMEOUT),
        )
        if "mainFrame" not in login.text:
            return search_olt_spa_by_sn(olt, target_sn, creds_cfg, sess, host)

        found = find_onu_by_serial(sess, host, target_sn)
        if not found:
            result["status"] = "not_found"
            return result

        pon, onu, description, model = found
        result["status"] = "found"
        result["pon"] = pon
        result["onu"] = onu
        result["auth_description"] = description
        result["auth_model"] = model

        # cross-reference macinfoPon.html for this pon:onu's client MACs and VLAN
        # *before* the bundle fetch, so the WAN RADIUS fallback (keyed on the
        # ONU's own MAC) has something to look up — we didn't arrive via a MAC match.
        client_mac = None
        try:
            page = sess.get(f"https://{host}/action/macinfoPon.html", timeout=(CONNECT_TIMEOUT, READ_TIMEOUT))
            rows = [
                {"vlan": ov, "mac": omac.lower(), "mac_type": ot}
                for _oi, ov, omac, ot, opon, oonu in ROW_RE.findall(page.text)
                if opon == pon and oonu == onu
            ]
            result["onu_macs"] = rows
            if rows:
                client_mac = rows[0]["mac"]
                result["vlan"] = rows[0]["vlan"]
        except requests.exceptions.RequestException:
            result["onu_macs"] = []

        result.update(fetch_onu_bundle(sess, host, pon, onu, mac=client_mac))
        result.update(fetch_pon_traffic(ip, pon))
        return result

    except requests.exceptions.ConnectTimeout:
        result["status"] = "unreachable"
        result["detail"] = "connect timeout"
    except requests.exceptions.ReadTimeout:
        result["status"] = "timeout"
        result["detail"] = "read timeout"
    except requests.exceptions.SSLError as e:
        result["status"] = "error"
        result["detail"] = f"TLS error: {e}"
    except requests.exceptions.ConnectionError:
        result["status"] = "unreachable"
        result["detail"] = "connection refused / no route"
    except Exception as e:  # noqa: BLE001
        result["status"] = "error"
        result["detail"] = str(e)
    return result


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/olts")
def api_olts():
    return jsonify(load_json(OLTS_PATH))


SN_RE = re.compile(r"^[A-Za-z]{4}[0-9A-Fa-f]{8}$")


@app.route("/api/search", methods=["POST"])
def api_search():
    body = request.get_json(force=True) or {}
    raw_query = body.get("mac", "").strip()
    mac = normalize_mac(raw_query)
    query_type = "mac" if mac else ("sn" if SN_RE.match(raw_query) else None)
    if not query_type:
        return jsonify({"error": f"'{raw_query}' is not a valid MAC address or ONU serial number (e.g. VSOL00260fde)"}), 400

    olts = load_json(OLTS_PATH)
    creds_cfg = load_json(CREDS_PATH)
    query = mac if query_type == "mac" else raw_query
    search_fn = search_olt if query_type == "mac" else search_olt_by_sn

    started = time.time()
    results = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(search_fn, olt, query, creds_cfg): olt for olt in olts}
        for fut in as_completed(futures):
            results.append(fut.result())

    results.sort(key=lambda r: (r["status"] != "found", r["ip"]))
    hits = [r for r in results if r["status"] in ("found", "found_unparsed")]

    # Start tracking this MAC going forward — onu_history_collect.py (cron)
    # will poll it for the trend graph on subsequent visits. Only for a clean
    # "found" hit with a resolved pon/onu; a MAC search tracks the searched
    # MAC itself, a serial search tracks the ONU's own client MAC if known.
    for h in hits:
        if h["status"] != "found" or h.get("pon") is None or h.get("onu") is None:
            continue
        track_mac = query if query_type == "mac" else (h.get("onu_macs") or [{}])[0].get("mac")
        if track_mac:
            watch_onu(
                track_mac, h["ip"], h.get("port"), h["pon"], h["onu"], h.get("label"), h.get("location"),
                rx_dbm=h.get("rx_power_dbm"), tx_dbm=h.get("tx_power_dbm"),
                wan_username=h.get("wan_username"),
            )

    return jsonify({
        "mac": query,
        "query_type": query_type,
        "elapsed_s": round(time.time() - started, 1),
        "scanned": len(olts),
        "hits": hits,
        "results": results,
    })


@app.route("/api/history/<path:raw_mac>")
def api_history(raw_mac):
    mac = normalize_mac(raw_mac) or raw_mac.strip().lower()
    since = time.time() - HISTORY_RETENTION_DAYS * 86400
    with db() as c:
        rows = c.execute(
            "SELECT ts, rx_dbm, tx_dbm, up_kbps, down_kbps FROM onu_history "
            "WHERE mac=? AND ts>=? ORDER BY ts",
            (mac, since),
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/refresh-fleet", methods=["POST"])
def api_refresh_fleet():
    """Re-pulls the authoritative OLT list from oltmon.olt_meta via .186 (only
    host allowed to reach .204:3306). Requires plink + the vmwarenms SSH creds."""
    plink = r"C:\Program Files\PuTTY\plink.exe"
    if not os.path.exists(plink):
        return jsonify({"error": "plink.exe not found, cannot refresh"}), 500

    query = (
        "mysql -h10.86.0.204 -ugrafana_ro -p'OltGrafana#Ro2026' oltmon "
        "-N -e \"SELECT olt_ip, olt_label, olt_location FROM olt_meta "
        "ORDER BY INET_ATON(olt_ip);\""
    )
    try:
        proc = subprocess.run(
            [
                plink, "-ssh", "imperial999@10.86.0.186",
                "-pw", "Imperial@999",
                "-hostkey", "SHA256:sL0z91iC8H3nbluI7fdSvIAzL4gepTHqdORx6yyiXs8",
                "-batch", query,
            ],
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        return jsonify({"error": "SSH to vmwarenms (.186) timed out"}), 504

    if proc.returncode != 0:
        return jsonify({"error": proc.stderr.strip() or "refresh failed"}), 500

    olts = []
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        ip, label, loc = parts[0], parts[1], parts[2]
        olts.append({"ip": ip, "label": label, "location": loc})

    if not olts:
        return jsonify({"error": "query returned no rows, fleet list left unchanged"}), 500

    with open(OLTS_PATH, "w", encoding="utf-8") as f:
        json.dump(olts, f, indent=2)

    return jsonify({"refreshed": len(olts)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
