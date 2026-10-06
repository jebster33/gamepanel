# Backups

<img src="../screenshots/backups.png" alt="Backups tab" width="800" />

A backup is a plain `.tar.gz` of the whole server folder, so you can open it anywhere.

## Making backups

- **By hand:** **Backups → Create backup**.
- **On a timer:** **Schedules → Add task** with **Make a backup**, for example every 6 hours.
- **Automatically:** the panel backs up before risky changes, like switching the Minecraft version or
  resetting a world.

## Restoring

- **Restore** puts the whole server back the way it was. Stop the server first; current files are
  overwritten.
- **Browse** opens the archive. Tick single files or folders and **Restore selected** to put back only
  those (a broken config, one world) and leave everything else alone. Administrators only.
- The download button saves the archive to your computer.

## Cloud copies

**Settings → Cloud backups** copies every backup, by hand or scheduled, to an S3-compatible bucket so a
dead disk doesn't take your worlds with it. Works with Backblaze B2, Cloudflare R2, Amazon S3, Wasabi and
MinIO.

1. Make a bucket, and a key that can only reach that bucket.
2. Pick your provider, fill in **Endpoint**, **Bucket**, **Region** (often guessed from the endpoint),
   **Access key ID** and **Secret access key**. **Folder in the bucket** is optional.
3. **Copies to keep per server**: 0 keeps every copy, or let a bucket lifecycle rule expire them.
4. **Test connection** writes, lists and deletes a small file, so you see the bucket's own error if
   something is wrong ([common errors](../troubleshooting.md#cloud-backups)).

After that the Backups tab gets a **Cloud** column. **Copy** retries an upload that failed. Backups that
are **Only in the cloud** have **Bring back**, which downloads them to the panel so you can restore them
like any other. Failed uploads are posted to your alerts when that alert is ticked.

## Backing up the panel itself

**Settings → System → Back up panel settings** downloads every account, setting, key and the player
history (not server files). Keep it somewhere safe: it holds every key. To restore, stop the panel and
unpack it into the data folder.

## Disk space

**Settings → Limits → Max storage** stops new backups when servers and backups together would go over
it. See [Limits](panel-settings.md#limits).
