# THE PERSONA EDGE — one audience's door into a product's API.
#
# Build context is the REPO ROOT, and PERSONA selects which generated config
# this image carries:
#
#   docker build -f apps/edge/Dockerfile --build-arg PERSONA=identity-holder .
#
# The image is nginx and a single allowlist. It holds no application code and no
# secrets: everything it can do is in deploy/persona-edges/<PERSONA>.conf, which
# is generated from packages/core/src/personas.ts and cannot be hand-edited
# without persona-edge-config.test.ts going red.
FROM nginx:1.27-alpine

ARG PERSONA
COPY deploy/persona-edges/ /tmp/persona-edges/

# FAIL AT BUILD, NOT AT RUN. Without this check an unset or misspelled PERSONA
# produces an image serving nginx's default welcome page on port 80 — which
# answers 200 to everything and proxies nothing, i.e. a container that looks
# healthy and is not the boundary anyone asked for.
RUN set -eu; \
    if [ -z "${PERSONA:-}" ]; then \
      echo "ERROR: --build-arg PERSONA=<persona> is required. Known:"; \
      ls /tmp/persona-edges/ | sed 's/\.conf$//' | sed 's/^/  /'; \
      exit 1; \
    fi; \
    if [ ! -f "/tmp/persona-edges/${PERSONA}.conf" ]; then \
      echo "ERROR: no generated config for persona '${PERSONA}'. Known:"; \
      ls /tmp/persona-edges/ | sed 's/\.conf$//' | sed 's/^/  /'; \
      echo "(run 'pnpm gen:persona-edges' if you have just added one)"; \
      exit 1; \
    fi; \
    cp "/tmp/persona-edges/${PERSONA}.conf" /etc/nginx/conf.d/default.conf; \
    # The other five configs must not travel in the image — an edge that carries
    # another persona's allowlist invites someone to "just point it at that one".
    rm -rf /tmp/persona-edges; \
    rm -f /etc/nginx/conf.d/default.conf.bak; \
    nginx -t

# Recorded so `docker inspect` answers "which persona is this?" without guessing
# from the config, and so the compose file's label and the image agree.
ARG PERSONA
ENV PERSONA=${PERSONA}
LABEL org.tokenlayer.persona=$PERSONA

EXPOSE 80
