#!/bin/bash
# Post-reboot health check for the JO host (10.86.0.173).
# Run:  ssh jo 'bash ~/jo-postboot-check.sh'   (or locally on the console)
# Exit code 0 = everything the website needs is up.
set -u
fail=0
ok()   { printf "  [ OK ] %s\n" "$1"; }
bad()  { printf "  [FAIL] %s\n" "$1"; fail=$((fail+1)); }
info() { printf "  [info] %s\n" "$1"; }

echo "== host =="
info "$(uptime -p), kernel $(uname -r)"
info "$(free -h | awk '/^Mem:/ {print "RAM total "$2", used "$3", available "$7}')"
info "$(free -h | awk '/^Swap:/ {print "swap total "$2", used "$3}')"
avail_mb=$(free -m | awk '/^Mem:/ {print $7}')
if [ "$avail_mb" -lt 400 ]; then bad "only ${avail_mb}MB available RAM - close desktop apps"; else ok "${avail_mb}MB RAM available"; fi

echo
echo "== network =="
ip4=$(ip -4 -o addr show ens160 | awk '{print $4}')
info "ens160 $ip4"
if [ "${ip4%%/*}" = "10.86.0.173" ]; then ok "IP unchanged (10.86.0.173)"; else bad "IP CHANGED to ${ip4%%/*} - DHCP gave a new lease, update the URL/reservation"; fi
ping -c1 -W2 10.86.0.254 >/dev/null 2>&1 && ok "gateway reachable" || bad "gateway 10.86.0.254 unreachable"

echo
echo "== docker =="
systemctl is-active --quiet docker && ok "docker.service active" || bad "docker.service not active"
for c in pdf_workflow_db pdf_workflow_backend pdf_workflow_frontend; do
  st=$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)
  if [ "$st" = "running" ]; then ok "$c running"; else bad "$c is $st"; fi
done
pmup=$(docker ps --filter "name=peering-manager" --format '{{.Names}}' | wc -l)
info "peering-manager containers running: $pmup/7"

echo
echo "== JO website =="
be=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 https://localhost/health)
[ "$be" = "200" ] && ok "backend /health 200" || bad "backend /health = $be"
fe=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 20 https://localhost/)
[ "$fe" = "200" ] && ok "frontend / 200 over https" || bad "frontend / = $fe (a fresh boot rebuilds it - can take ~2 min)"
redir=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:3000/)
[ "$redir" = "301" ] && ok "plaintext :3000 redirects to https" || bad "plaintext :3000 = $redir (expected a 301)"
api_redir=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:8080/health)
[ "$api_redir" = "308" ] && ok "plaintext :8080 redirects to https" || bad "plaintext :8080 = $api_redir (expected a 308)"
cert_days=$(( ( $(date -d "$(echo | openssl s_client -connect localhost:443 2>/dev/null | openssl x509 -noout -enddate | cut -d= -f2)" +%s) - $(date +%s) ) / 86400 ))
[ "$cert_days" -gt 30 ] && ok "TLS certificate valid for $cert_days more days" || bad "TLS certificate expires in $cert_days days"
asset=$(curl -sk --max-time 10 https://localhost/ | grep -o 'assets/index-[^"]*\.js' | head -1)
[ -n "$asset" ] && ok "index references $asset" || bad "no hashed asset in index.html"
login=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 -X POST https://localhost/api/auth/login \
        -H 'Content-Type: application/json' -d '{"email":"__probe__","password":"__probe__"}')
[ "$login" = "401" ] || [ "$login" = "400" ] && ok "auth endpoint answering ($login on bad creds)" || bad "auth endpoint = $login"

echo
echo "== data =="
rows=$(docker exec pdf_workflow_db psql -U postgres -d pdf_workflow -tAc \
  "SELECT 'users='||(SELECT count(*) FROM users)||' pdfs='||(SELECT count(*) FROM generated_pdfs)||' templates='||(SELECT count(*) FROM pdf_templates)||' attachments='||(SELECT count(*) FROM generated_pdf_attachments)" 2>&1)
case "$rows" in
  users=*) ok "postgres reachable: $rows" ;;
  *)       bad "postgres query failed: $rows" ;;
esac
files=$(find /home/uisp/JO/jo-website/storage -type f 2>/dev/null | wc -l)
info "storage files: $files (expected ~7654 as of 2026-08-16)"
[ "$files" -gt 7000 ] && ok "storage tree intact" || bad "storage file count looks wrong"

echo
echo "== backups =="
if [ -f /home/jo-ssh/backups/last-run.txt ]; then
  status=$(cat /home/jo-ssh/backups/last-run.txt)
  age_h=$(( ( $(date +%s) - $(stat -c %Y /home/jo-ssh/backups/last-run.txt) ) / 3600 ))
  case "$status" in
    OK*) if [ "$age_h" -lt 30 ]; then ok "last backup $status"; else bad "last backup is ${age_h}h old: $status"; fi ;;
    *)   bad "last backup reported a failure: $status" ;;
  esac
  info "off-box copy: $(sed -n 's/.*host=//p' /home/jo-ssh/backups/last-run.txt):/home/zabbix/jo-backups (encrypted)"
else
  bad "no backup has ever run (expected /home/jo-ssh/backups/last-run.txt)"
fi

echo
echo "== other services on this box =="
for s in traccar apache2 nginx mariadb postgresql@14-main snmpd; do
  systemctl is-active --quiet "$s" && ok "$s active" || info "$s not active"
done

echo
echo "== top memory consumers =="
ps -eo rss,comm --sort=-rss | head -6 | awk 'NR>1 {printf "  %6.0f MB  %s\n", $1/1024, $2}'

echo
if [ "$fail" -eq 0 ]; then
  echo "RESULT: all checks passed"
else
  echo "RESULT: $fail check(s) FAILED"
fi
exit "$fail"
