# Photo Viewer

Pull JPG previews of RAW photos from a Google Drive folder, cull them with the keyboard, and export the file names of the RAWs you starred.

There are two ways to use it:

- **On the web (any phone or computer):** https://chlomoney-14.github.io/photo-viewer/. Nothing to install. See [Web version](#web-version) below.
- **On a Mac, with folders on disk:** run the local server, as described in the rest of this README.

## Web version

The web version is the `public/` folder published to GitHub Pages. The site only holds the app; your photos never go to GitHub.

1. Open the site and tap **Download from Google Drive**.
2. Paste the link to a Drive folder shared as **Anyone with the link**, plus a Google API key the first time (the dialog explains how to make one in about 5 minutes; it's saved on that device).
3. Pick a size (2048 px is about 0.5 MB a photo, so about 1 GB for 1,850 photos) and tap **Download**.

The JPG previews download straight from Google into the browser's storage on that device. Next time you open the site, they're already there, and it works offline. If the photos are gone (say the browser's storage was cleared), it asks you to download again or to choose JPGs already on the device (**⋯ › Add photos from this device**).

- **iPhone:** in Safari tap Share › **Add to Home Screen** and use it from the home-screen icon. iOS can clear storage for websites you haven't opened in a while, but not for home-screen apps.
- Stars are kept on each device. **Export** gives the list of starred RAW names to copy, save as .txt or share; **⋯ › Star from a list** loads a list back in, so you can move stars between devices.
- Zooming in loads a sharper 4096 px copy from Drive while online.
- **⋯ › Remove photos from this device** frees the space.
- To skip the API key step for everyone, put a key in `public/config.js`. It's public there, so restrict it in Google Cloud to your Pages address and the Drive API.

Every push to `main` republishes the site (see `.github/workflows/pages.yml`).

## Mac version

No dependencies — just Node 18+.

```bash
npm start
```

This opens http://localhost:5178 in your browser.

## 1. Google API key (optional)

For a Drive folder shared as **Anyone with the link**, no key is needed: the app reads the file list from Drive's public folder page. Add a Google Drive API key if you'd rather use the official API (or the public page stops working):

1. Go to https://console.cloud.google.com/ and create a project (any name).
2. Open **APIs & Services → Library**, search for **Google Drive API**, and click **Enable**.
3. Open **APIs & Services → Credentials → Create credentials → API key**. Copy the key (starts with `AIza`).
4. Optional but recommended: edit the key and restrict it to the Google Drive API.

The key is saved in `config.json` next to `server.js` after the first successful download, so you only paste it once. You can also set `GOOGLE_API_KEY` in the environment instead.

## 2. Download the previews

Click **Download from Drive**, paste the folder link, choose where to save, and pick a size. Sizes below are averages measured on a Sony a7 IV shoot:

| Size | Per photo | ~1,850 photos |
| --- | --- | --- |
| 1600 px | ~0.4 MB | ~0.7 GB |
| 2560 px | ~0.7 MB | ~1.3 GB |
| 4000 px | ~1.4 MB | ~2.6 GB |
| 6000 px (default) | ~2.2 MB | ~4 GB |
| Full resolution | ~3 MB | ~5.5 GB |

Drive renders each JPG from the preview embedded in the RAW, so the 65 MB RAW files are never downloaded. If Drive can't render a preview for a file, the app downloads that one RAW and converts it locally with macOS `sips`. Each JPG is named after its RAW (`OCT01574.ARW` → `OCT01574.jpg`). Running it again skips files you already have, so it is safe to re-run after a cancel or to pick up new photos.

For a big folder you can run the download from the terminal instead, so it doesn't depend on a browser tab:

```bash
npm run download -- "https://drive.google.com/drive/folders/…" ~/Pictures/my-shoot 6000
```

Set `DOWNLOAD_CONCURRENCY` (default 6) to change how many files download at once.

## 3. Cull

Open any folder of JPGs with **Open folder** (the last one reopens automatically).

| Key | Action |
| --- | --- |
| ← → | Previous / next photo |
| Space | Star / unstar |
| Scroll, pinch | Zoom at the cursor |
| Drag | Pan when zoomed |
| Double-click, Z | Toggle fit / 100% |
| + − | Zoom in / out |
| 0 | Fit to window |
| S | Show all / starred only |
| Home, End | First / last photo |
| ? | Shortcut help |

Zoom stays put when you move between photos, so you can compare focus across a burst.

Stars save automatically to `.stars.json` in the photo folder. **★ Starred** in the top bar (or **S**) shows only starred photos. Drag the bar under the thumbnails to jump anywhere in the shoot.

### Star from a list

**⋯ › Star from a list…** stars every photo named in a list: paste names or load a .txt file. RAW names (`OCT01574.ARW`), JPG names or bare names (`OCT01574`) all work, one per line or separated by commas or spaces. Names that don't match a photo are listed so you can check them. Tick **Unstar everything else first** to make the list the complete set of stars. An exported list loads straight back in.

## 4. Export

**Export starred** writes `starred-raws_<date>_<time>.txt` into the photo folder with one RAW file name per line (e.g. `OCT01574.ARW`). The dialog also lets you copy the list or show the file in Finder.

The RAW names come from `.raw-manifest.json`, which the downloader writes. For JPGs that came from somewhere else, the app uses a RAW file with the same name in that folder if there is one, and otherwise assumes `.ARW`.

## On your phone (home Wi-Fi)

```bash
npm run phone
```

This starts the viewer so phones on the same Wi-Fi can reach it. Click **Phone** in the viewer on your Mac and scan the QR code with your phone's camera. Nothing is uploaded anywhere: the phone loads the photos straight from your Mac, which has to stay awake with the viewer running.

- Swipe to browse, pinch to zoom, double-tap for 100%, and tap ☆ to star. Drag the bar under the thumbnails to scroll them.
- When you zoom in past what the phone copy can show, the visible area is fetched from the full-size JPG, so focus checks are as sharp as on the Mac.
- Stars made on the phone and on the Mac go into the same list, so you can export from either.
- Phones get 2048 px copies of each photo, cached in `.phone/` in the photo folder (about 0.56 MB each).
- The link contains a secret key, so other devices on your network can't open the viewer without it. Phones can only see the folder currently open on the Mac, and can't open folders, download, or touch anything else on it.
- The first time, macOS may ask whether `node` can accept incoming network connections. Click **Allow**.

Plain `npm start` stays private to the Mac.

### Offline copy (view away from home)

The phone viewer only works while your phone can reach the Mac. To keep the photos on your phone, while on home Wi-Fi tap **⋯ › Save offline copy…** and pick **Starred only** or **Every photo** (about 1 GB for this shoot). The page shows a progress bar, then where the file went.

- It's a .zip in the **Files** app under **Downloads**: on iPhone usually **iCloud Drive › Downloads**, or **On My iPhone › Downloads** if iCloud Drive is off. **Settings › Apps › Safari › Downloads** shows which.
- Tap the .zip once to unzip it. You get a folder with **Starred** (everything starred on any device when you downloaded) and, if you chose it, **All**, plus `starred-raws.txt`.
- Open a photo there and swipe, or select them and **Save to Photos**. No Wi-Fi or Mac needed.
- Stars added later aren't in the copy. Download again to update it.

## Files the app creates in your photo folder

- `.raw-manifest.json`: maps each JPG to its RAW name and Drive file ID
- `.stars.json`: your starred photos
- `.thumbs/`: small filmstrip thumbnails, made with macOS `sips`
- `.phone/`: 2048 px copies for phones
- `starred-raws_*.txt`: your exports

## Notes

- Only files directly inside the Drive folder are fetched. Files in subfolders are skipped.
- `npm start` only listens on `localhost`; `npm run phone` also listens on your local network. Set `PORT` to change the port.
