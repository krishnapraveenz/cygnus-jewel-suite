# Cygnus biometric sync agent

Pulls attendance punches from an eSSL / CP Plus / ZKTeco device over the LAN
(ZK protocol, TCP 4370) and pushes them to Cygnus, which folds them into
attendance automatically. This is the **reliable "no-CSV" path**.

## Why an agent?
The device speaks a binary protocol on port 4370 that a browser/desktop app can't
reach directly. A tiny helper on the same LAN bridges the device → Cygnus.

## Install
```
pip install -r requirements.txt      # pyzk + requests
```

## Configure
1. In Cygnus → **Biometric Devices**, set (or generate) an **Agent Key**.
2. Ensure each staff member's **Biometric user ID** matches their enrollment ID on the device.

## Run
```
# one-shot
python agent.py --device 192.168.1.201 --server http://<cygnus-pc>:8787 --key <AGENT_KEY>

# continuous, every 5 minutes
python agent.py --device 192.168.1.201 --server http://<cygnus-pc>:8787 --key <AGENT_KEY> --interval 300
```
Add `--clear` to clear the device's log buffer after a successful pull, and
`--device-id N` to tag punches with a Cygnus device.

## Run as a service
- **Windows**: use Task Scheduler ("At log on", repeat) or `nssm` to wrap it.
- **Linux**: a `systemd` unit with `Restart=always`.

## Security
`/biometric/agent-ingest` is authenticated only by the Agent Key header — keep the
key secret and run the agent on a trusted LAN. Rotate the key in Cygnus to revoke.
