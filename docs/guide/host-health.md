# Host health, restarting the machine and storage

All of this is for administrators. It answers three questions: is the machine itself healthy, can I restart it without hurting my servers, and where is the disk space going.

## Host health card

The dashboard has a **Host health** card: uptime, whether a reboot is waiting, how many days until the disk is full at the current growth rate (needs about half a day of history), pending operating system updates, disk SMART status and temperatures. Problems (a failing disk, a hot machine, a disk filling within a week, waiting security updates, a reboot pending for over a week) are sent through your usual alert channels as "Host health warning" (Settings, Alerts lets you pick which events go where).

- **SMART** needs `smartmontools` on Linux (`sudo apt install smartmontools`). The installer lets the panel run it through sudo; on an existing install add `gamepanel ALL=(root) NOPASSWD: /usr/sbin/smartctl -H -A -i -j /dev/*` with `sudo visudo -f /etc/sudoers.d/gamepanel`. Windows uses Get-PhysicalDisk.
- **Temperatures** come from `/sys/class/hwmon`, thermal zones and, on a Raspberry Pi, `vcgencmd` (which also flags under-voltage and heat throttling). Virtual machines usually expose none. Windows shows them only on hardware that reports them.
- **OS updates**: apt, dnf or pacman (with `checkupdates`) on Linux, Windows Update on Windows. The count is cached for six hours. The apt count uses the package lists already on the machine.

## Restart or shut down the host

**Restart host...** and **Shut down host...** on that card show a preview first (the servers that will be stopped, in order, and the exact command), then count down for 60 seconds with a warning in game chat, stop each server cleanly (so it saves), and run the operating system command. After the machine is back, the panel starts exactly the servers that were running, not the others. **Cancel** works until the final command is sent; servers already stopped are started again.

Linux needs permission to run the command. New installs get it from `install.sh`; on an existing install add this line with `sudo visudo -f /etc/sudoers.d/gamepanel`:

```
gamepanel ALL=(root) NOPASSWD: /usr/bin/systemctl reboot, /bin/systemctl reboot, /usr/bin/systemctl poweroff, /bin/systemctl poweroff
```

(Replace `gamepanel` with the panel's service user.) Windows uses `shutdown /r` or `/s`. The preview tells you when the permission is missing.

## Storage tab

Each server has a **Storage** tab: a bar of disk use per top-level folder (world, mods, logs, cache), the biggest files, and bandwidth. The scan stops after 300,000 files or 20 seconds and says so, and is cached for five minutes.

Bandwidth is only known for servers running in a container (from Docker's network counters): live rate, a 24 hour graph and monthly totals. A plain process shares the host's network, so Linux cannot say how much belongs to it, and Windows has no per-process counters; the tab says so instead of guessing.

## Log rules

On the Storage tab (per server) and under Settings, Log retention (global): delete logs older than N days, compress them after N days, keep a log folder under N MB. Runs daily; **Preview** shows what would happen. See [panel settings](panel-settings.md#log-retention).
