# GamePanel in a container. See docs/guide/install-docker.md.
#
# The panel has no npm dependencies, so this image is just Node plus the few
# tools it shells out to (git for config sync, tar/unzip for backups and
# downloads). Game servers are started through the Docker socket you mount, as
# sibling containers on the host.
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git tar gzip unzip xz-utils procps lib32gcc-s1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/gamepanel
COPY package.json ./
COPY server ./server
COPY public ./public
COPY templates ./templates
COPY setups ./setups
COPY cli ./cli
COPY bridge ./bridge
COPY docs ./docs

# Same path inside and outside the container: game containers bind-mount their
# server folder by the path the panel gives them, and the Docker daemon
# resolves that path on the host.
ENV NODE_ENV=production \
    GP_DATA_DIR=/var/lib/gamepanel \
    GP_PORT=8420 \
    GP_HOST=0.0.0.0
VOLUME ["/var/lib/gamepanel"]
EXPOSE 8420

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.GP_PORT||8420)+'/api/status',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/index.js"]
