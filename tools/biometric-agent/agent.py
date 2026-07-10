#!/usr/bin/env python3
"""
Cygnus biometric sync agent.

Runs on a PC on the SAME LAN as your eSSL / CP Plus / ZKTeco device. It pulls
attendance punches from the device over TCP (ZK protocol, port 4370) using the
`pyzk` library and POSTs them to the Cygnus backend, which folds them into
attendance automatically. This is the reliable "automatic" path — no CSV needed.

SETUP
    pip install pyzk requests
    # In Cygnus → Biometric Devices, set/generate an Agent Key and copy it here.

RUN
    python agent.py --device 192.168.1.201 --server http://<cygnus-pc>:8787 --key <AGENT_KEY>
    # add --interval 300 to poll every 5 min; --clear to clear device logs after a successful pull.

Notes
- The device's enrollment "User ID" must match each staff member's "Biometric user ID"
  in Cygnus. Unknown IDs land under Biometric Devices → Unmatched punches for mapping.
- Safe to run continuously (systemd / Windows Task Scheduler / nssm).
"""
import argparse
import time
import sys

try:
    from zk import ZK  # pyzk
except ImportError:
    sys.exit("Missing dependency: pip install pyzk")
import requests


def pull_once(device_ip, device_port, server, key, device_id, clear):
    zk = ZK(device_ip, port=device_port, timeout=10, force_udp=False, ommit_ping=True)
    conn = None
    try:
        conn = zk.connect()
        conn.disable_device()  # freeze while reading (recommended by ZK SDK)
        logs = conn.get_attendance() or []
        punches = [[str(a.user_id), a.timestamp.strftime("%Y-%m-%d %H:%M:%S")] for a in logs]
        if not punches:
            print("no punches on device")
            return
        body = {"punches": punches}
        if device_id:
            body["device_id"] = int(device_id)
        resp = requests.post(
            f"{server.rstrip('/')}/biometric/agent-ingest",
            json=body,
            headers={"x-agent-key": key},
            timeout=30,
        )
        resp.raise_for_status()
        out = resp.json()
        print(f"sent {len(punches)} punches -> inserted {out.get('inserted')}")
        if clear and out.get("ok"):
            conn.clear_attendance()
            print("cleared device attendance buffer")
    finally:
        if conn:
            try:
                conn.enable_device()
                conn.disconnect()
            except Exception:
                pass


def main():
    ap = argparse.ArgumentParser(description="Cygnus biometric sync agent")
    ap.add_argument("--device", required=True, help="device IP, e.g. 192.168.1.201")
    ap.add_argument("--port", type=int, default=4370)
    ap.add_argument("--server", required=True, help="Cygnus backend URL, e.g. http://192.168.1.10:8787")
    ap.add_argument("--key", required=True, help="Agent Key from Cygnus → Biometric Devices")
    ap.add_argument("--device-id", type=int, default=0, help="optional Cygnus device id to tag punches")
    ap.add_argument("--interval", type=int, default=0, help="poll seconds (0 = run once and exit)")
    ap.add_argument("--clear", action="store_true", help="clear device logs after a successful pull")
    args = ap.parse_args()

    while True:
        try:
            pull_once(args.device, args.port, args.server, args.key, args.device_id, args.clear)
        except Exception as e:  # noqa: BLE001 - keep the loop alive
            print(f"error: {e}", file=sys.stderr)
        if args.interval <= 0:
            break
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
