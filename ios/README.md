# GamePanel for iPhone

A native SwiftUI app for GamePanel: servers, power, live console, players, graphs, backups, files and mods, for one or more panels. It talks to the panel's normal HTTP API and `/ws` feed, so the panel needs no changes.

- `GamePanel/`: the app (iosc project, builds on Windows).
- `GamePanelWidgets/`: the Dynamic Island / Lock Screen Live Activity and Home Screen widget. **Not built yet**: iosc can't make app extensions. See [Widgets](#widgets).

Needs iOS 26 or newer (Liquid Glass).

## Build on Windows

This uses the native Windows iOS toolchain ([iosc](https://github.com/DiamondDeadMaw/iosc) through `windows-apple-dev`). No Mac, VM or Xcode run.

One-time setup:

1. Install the [Swift toolchain for Windows](https://www.swift.org/install/windows/) and Visual Studio Build Tools with **Desktop development with C++**.
2. Download Xcode's `.xip` from [developer.apple.com/download/all](https://developer.apple.com/download/all) and extract its SDK into a **short** folder (Xcode's paths go past Windows' 260-character limit otherwise):

   ```powershell
   $env:IOSC_EXTERNAL = 'C:\iosc'
   apple-dev swift sdk extract $HOME\Downloads\Xcode_27.1.xip
   ```

3. Build the SwiftUI macro plugins once (iosc's `macros/build.ps1`). Build them from a short folder too.

Build:

```powershell
$env:IOSC_EXTERNAL = 'C:\iosc'
apple-dev swift --project ios\GamePanel build
```

## Install on your iPhone (free Apple ID)

Sign in to Apple in your own terminal, never in chat or a script:

```powershell
apple-dev swift auth login you@example.com
apple-dev swift --project ios\GamePanel sign --apple-id you@example.com
apple-dev swift --project ios\GamePanel install
```

Free Apple ID builds expire after 7 days. Sign and install again to renew. Developer Mode must be on (Settings → Privacy & Security → Developer Mode).

## Signing in

Enter the address you open GamePanel at (`192.168.1.20:8420`, `panel.example.com`, or a full URL), your username and password, and the 2FA code if you use one. The session token is kept in the iOS Keychain (this device only) and sent as the panel's `gp_session` cookie. Plain `http://` panels work; the app allows it because most panels run without HTTPS on a home network.

## Widgets

`GamePanelWidgets/` holds:

- `Shared/ServerActivity.swift`: the Live Activity attributes (pinned server, or a long task such as a backup).
- `Extension/`: the widget extension: Dynamic Island (compact, minimal, expanded), Lock Screen card, Home Screen widget.
- `AppSide/LiveActivities.swift`: starts/updates/ends activities and writes the widget snapshot.

To switch them on you need a build tool that makes app extensions (Xcode on a Mac, or iosc once it supports them):

1. Make a Widget Extension target from `Extension/` plus `Shared/`.
2. Add `Shared/` and `AppSide/LiveActivities.swift` to the app, set `NSSupportsLiveActivities = true` in its Info.plist, and call `LiveActivities.shared.sync(session)` when the server list changes.
3. Give both targets the App Group `group.com.jebster33.gamepanel`.

Without push (a free Apple ID can't use APNs), Live Activities update while the app is open or briefly in the background.
