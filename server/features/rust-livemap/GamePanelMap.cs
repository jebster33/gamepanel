using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace Oxide.Plugins
{
    [Info("GamePanelMap", "gamepanel", "1.0.0")]
    [Description("Answers the game panel's live map over RCON: gamepanel.map info|players|events|bases|teams|entities [page]")]
    class GamePanelMap : RustPlugin
    {
        const int MonumentPage = 40;
        const int PlayerPage = 30;
        const int BasePage = 40;
        const int TeamPage = 25;
        const int EntityPage = 40;

        List<object[]> baseCache = new List<object[]>();
        DateTime baseCacheAt = DateTime.MinValue;
        List<string> entityCache = new List<string>();
        int entityTotal = 0;
        DateTime entityCacheAt = DateTime.MinValue;

        static string Esc(string s)
        {
            if (s == null) return "";
            var sb = new StringBuilder();
            foreach (var c in s)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < 32) sb.Append(' ');
                else sb.Append(c);
            }
            return sb.ToString();
        }

        static string N(float v) { return ((int)Math.Round(v)).ToString(CultureInfo.InvariantCulture); }

        [ConsoleCommand("gamepanel.map")]
        void CmdMap(ConsoleSystem.Arg arg)
        {
            // The server console and RCON have no connection; in game only admins may ask.
            if (arg.Connection != null && arg.Connection.authLevel < 2) return;
            var what = arg.GetString(0, "info");
            var page = Math.Max(0, arg.GetInt(1, 0));
            switch (what)
            {
                case "info": Info(arg, page); break;
                case "players": Players(arg, page); break;
                case "events": Events(arg); break;
                case "bases": Bases(arg, page); break;
                case "teams": Teams(arg, page); break;
                case "entities": Entities(arg, page); break;
            }
        }

        void Info(ConsoleSystem.Arg arg, int page)
        {
            var list = new List<string>();
            if (TerrainMeta.Path != null && TerrainMeta.Path.Monuments != null)
            {
                foreach (var m in TerrainMeta.Path.Monuments)
                {
                    if (m == null) continue;
                    var name = m.displayPhrase != null ? m.displayPhrase.english : null;
                    if (string.IsNullOrEmpty(name)) continue;
                    var p = m.transform.position;
                    list.Add("[\"" + Esc(name) + "\"," + N(p.x) + "," + N(p.z) + "]");
                }
            }
            var slice = list.Skip(page * MonumentPage).Take(MonumentPage).ToList();
            var more = list.Count > (page + 1) * MonumentPage;
            arg.ReplyWith("{\"size\":" + World.Size + ",\"seed\":" + World.Seed + ",\"more\":" + (more ? "true" : "false") + ",\"monuments\":[" + string.Join(",", slice.ToArray()) + "]}");
        }

        void Players(ConsoleSystem.Arg arg, int page)
        {
            var all = BasePlayer.activePlayerList.Where(p => p != null && p.IsConnected).ToList();
            var slice = all.Skip(page * PlayerPage).Take(PlayerPage).Select(p =>
            {
                var pos = p.transform.position;
                return "[\"" + p.userID + "\",\"" + Esc(p.displayName) + "\"," + N(pos.x) + "," + N(pos.z) + "," + N(p.health) + "," + (p.currentTeam) + "]";
            });
            var more = all.Count > (page + 1) * PlayerPage;
            arg.ReplyWith("{\"total\":" + all.Count + ",\"sleepers\":" + BasePlayer.sleepingPlayerList.Count + ",\"more\":" + (more ? "true" : "false") + ",\"players\":[" + string.Join(",", slice.ToArray()) + "]}");
        }

        void Events(ConsoleSystem.Arg arg)
        {
            var found = new List<string>();
            foreach (var e in BaseNetworkable.serverEntities)
            {
                string kind = null;
                if (e is CargoShip) kind = "cargo";
                else if (e is BaseHelicopter) kind = "heli";
                else if (e is CH47HelicopterAIController) kind = "chinook";
                else if (e is BradleyAPC) kind = "bradley";
                else if (e is SupplyDrop) kind = "drop";
                else if (e is HackableLockedCrate) kind = "crate";
                if (kind == null) continue;
                var p = (e as BaseEntity).transform.position;
                found.Add("[\"" + kind + "\"," + N(p.x) + "," + N(p.z) + "]");
                if (found.Count >= 120) break;
            }
            arg.ReplyWith("{\"events\":[" + string.Join(",", found.ToArray()) + "]}");
        }

        // Tool cupboards stand for bases. Scanning every entity is the slow part, so it is cached.
        void Bases(ConsoleSystem.Arg arg, int page)
        {
            if ((DateTime.UtcNow - baseCacheAt).TotalSeconds > 30)
            {
                baseCache.Clear();
                foreach (var e in BaseNetworkable.serverEntities)
                {
                    var tc = e as BuildingPrivlidge;
                    if (tc == null) continue;
                    var p = tc.transform.position;
                    var id = tc.OwnerID;
                    var player = id == 0 ? null : covalence.Players.FindPlayerById(id.ToString());
                    baseCache.Add(new object[] { id, player != null ? player.Name : "", p.x, p.z, tc.authorizedPlayers.Count });
                }
                baseCacheAt = DateTime.UtcNow;
            }
            var slice = baseCache.Skip(page * BasePage).Take(BasePage).Select(b =>
                "[\"" + b[0] + "\",\"" + Esc(((string)b[1]).Length > 24 ? ((string)b[1]).Substring(0, 24) : (string)b[1]) + "\"," + N((float)b[2]) + "," + N((float)b[3]) + "," + b[4] + "]");
            var more = baseCache.Count > (page + 1) * BasePage;
            arg.ReplyWith("{\"total\":" + baseCache.Count + ",\"more\":" + (more ? "true" : "false") + ",\"bases\":[" + string.Join(",", slice.ToArray()) + "]}");
        }

        // Rust teams: [teamId, leaderId, [memberIds...]]
        void Teams(ConsoleSystem.Arg arg, int page)
        {
            var rows = new List<string>();
            var manager = RelationshipManager.ServerInstance;
            if (manager != null)
            {
                foreach (var kv in manager.teams)
                {
                    var team = kv.Value;
                    if (team == null || team.members == null || team.members.Count == 0) continue;
                    rows.Add("[\"" + team.teamID + "\",\"" + team.teamLeader + "\",[" + string.Join(",", team.members.Select(m => "\"" + m + "\"").ToArray()) + "]]");
                }
            }
            var slice = rows.Skip(page * TeamPage).Take(TeamPage);
            var more = rows.Count > (page + 1) * TeamPage;
            arg.ReplyWith("{\"total\":" + rows.Count + ",\"more\":" + (more ? "true" : "false") + ",\"teams\":[" + string.Join(",", slice.ToArray()) + "]}");
        }

        // Entities per owner, biggest first: [ownerId, name, total, buildingParts, deployables, x, y, z].
        // Scanning every entity is slow, so the answer is cached for a minute.
        void Entities(ConsoleSystem.Arg arg, int page)
        {
            if ((DateTime.UtcNow - entityCacheAt).TotalSeconds > 60)
            {
                var owners = new Dictionary<ulong, float[]>();
                var all = 0;
                foreach (var e in BaseNetworkable.serverEntities)
                {
                    var be = e as BaseEntity;
                    if (be == null) continue;
                    all++;
                    if (be.OwnerID == 0) continue;
                    if (be is BasePlayer) continue;
                    float[] a;
                    if (!owners.TryGetValue(be.OwnerID, out a)) { a = new float[6]; owners[be.OwnerID] = a; }
                    a[0]++;
                    if (be is BuildingBlock) a[1]++; else a[2]++;
                    var p = be.transform.position;
                    a[3] += p.x; a[4] += p.y; a[5] += p.z;
                }
                entityTotal = all;
                entityCache = owners.OrderByDescending(o => o.Value[0]).Take(200).Select(o =>
                {
                    var player = covalence.Players.FindPlayerById(o.Key.ToString());
                    var n = player != null ? player.Name : "";
                    if (n.Length > 24) n = n.Substring(0, 24);
                    var c = o.Value[0];
                    return "[\"" + o.Key + "\",\"" + Esc(n) + "\"," + c + "," + o.Value[1] + "," + o.Value[2] + "," + N(o.Value[3] / c) + "," + N(o.Value[4] / c) + "," + N(o.Value[5] / c) + "]";
                }).ToList();
                entityCacheAt = DateTime.UtcNow;
            }
            var slice = entityCache.Skip(page * EntityPage).Take(EntityPage);
            var more = entityCache.Count > (page + 1) * EntityPage;
            arg.ReplyWith("{\"all\":" + entityTotal + ",\"more\":" + (more ? "true" : "false") + ",\"owners\":[" + string.Join(",", slice.ToArray()) + "]}");
        }
    }
}
