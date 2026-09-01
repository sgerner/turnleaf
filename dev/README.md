# Local Kavita for development

This runs a real Kavita server in Docker so Turnleaf's onboarding screen has something genuine to
connect to during development, instead of needing a production server.

## Start it

```bash
docker compose -f dev/docker-compose.yml up -d
```

This uses LinuxServer.io's Kavita image.

Kavita is then at http://localhost:5000. Config persists in `dev/kavita/config/` and is
gitignored.

## First-time setup

1. Open http://localhost:5000 and complete the setup wizard (creates the admin account).
2. A small sample book is already in `dev/kavita/data/Books/lorem-ipsum.epub` (a two-chapter
   Lorem Ipsum EPUB, a few KB, checked into the repo). Add more of your own EPUBs into
   `dev/kavita/data/Books/` if you want — those are gitignored. Kavita won't scan files sitting
   directly at the library root, so they need to be inside a subfolder like `Books/`.
3. In Kavita, add a library: **Settings > Libraries > Add Library**, type **Book**, folder
   `/data`. Scan it.
4. Generate an API key for your user: **Settings > Users > (your user) > edit > API Key**.

## Connect Turnleaf to it

Run Turnleaf's dev server (`npm run dev`) and use the onboarding form:

- Server address: `http://localhost:5000`
- Since this is plain HTTP, check "Allow plain HTTP" (fine for local dev, not for real servers).
- Auth key: the API key from step 4.

## Stop / reset

```bash
docker compose -f dev/docker-compose.yml down       # stop, keep data
docker compose -f dev/docker-compose.yml down -v     # stop, drop the named volume (none used here)
rm -rf dev/kavita/config                             # wipe Kavita's config/db to start clean
```
