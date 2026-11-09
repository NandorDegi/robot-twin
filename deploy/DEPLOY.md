# robot-twin deployment

The deployment runbook is [`docs/NUC-BRINGUP.md`](../docs/NUC-BRINGUP.md).

Files in this folder:

| File | Purpose |
|---|---|
| `install.sh` | Installs everything on the NUC (Ubuntu 22.04, x86_64) except the brain. Starts nothing. |
| `brain/install-brain.sh` | Installs the brain after `install.sh`: intuition sidecar (searchless_chess 9M), reflection SLM (llama.cpp + Qwen3-1.7B), optional Maia. Starts nothing. |
| `brain/systemd/` | `robot-intuition` (127.0.0.1:8095), `robot-reflection` (127.0.0.1:8090). |
| `robot-twin.env.template` | Configuration template -> `/etc/robot-twin/robot-twin.env`. No secrets. |
| `caddy.env.template` | Caddy allowlist and port -> `/etc/robot-twin/caddy.env`. |
| `Caddyfile` | Reverse proxy: twin, `/robot-ws`, `/vision/*`. |
| `setup-fci-network.sh` | Static IP on the dedicated FCI NIC (netplan, NetworkManager off). |
| `preflight.sh` | Read-only checks before a session with the robot. |
| `franka-recover.sh` | Operator recovery after a reflex. |
| `make-bundle.sh` | Builds `dist/robot-twin-nuc-<date>.tar.gz` (dev machine). |
| `systemd/` | `robot-franka`, `robot-server`, `robot-vision`, `robot-cpu-performance`, optional `robot-ros`, Caddy drop-in. |

`deploy/.env.example` from the generated version is not used and not in the
bundle (it was never reviewed; see the review notes).
