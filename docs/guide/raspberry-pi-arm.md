# Raspberry Pi and other ARM machines

GamePanel itself runs on ARM (64-bit Raspberry Pi OS or any arm64 Debian or Ubuntu). Whether a game runs depends on the game:

- **Java games** (Minecraft Java and its variants, Mindustry, Velocity...) run natively and well. A Pi 4 or 5 with 4 to 8 GB is fine for a small Minecraft server.
- **Steam games and Bedrock** are built for x86 only. They can run through **box64** (64-bit programs) and **box86** (32-bit programs, including SteamCMD), which translate x86 code. It is slower, and some games do not work at all.
- Windows-only games are not supported on ARM.

On an ARM machine the template catalogue shows a badge on each game: **Works on this machine**, **Works with box64**, **Needs box64** or **Not supported**.

## Installing box64

Debian 13 and recent Ubuntu carry it in their repositories:

```
sudo apt install box64
```

(On 32-bit ARM use `box86`.) On older systems use the project's own instructions at https://github.com/ptitSeb/box64 . The panel's sudo rule allows `apt-get`, so `POST /api/system/arch/box64` with `{"confirm":true}` installs it for you; it only ever runs `apt-get install -y box64` (or `box86`) after your confirmation.

## What the panel does with it

When box64/box86 is installed, a start command such as `./RustDedicated ...` that points to an x86 binary in the server folder is run as `box64 ./RustDedicated ...` (`box86` for 32-bit binaries). SteamCMD is run through box86. Nothing changes on x86 machines. Container servers use the container image's architecture; x86 images on ARM Docker need `qemu-user-static` and are slow, so prefer native Java games there.

This was written against the documented behaviour of box64 and has not been tested on real ARM hardware.
