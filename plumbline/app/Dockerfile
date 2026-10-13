FROM node:20-alpine
WORKDIR /app
# Allowlist: only the static site and its tiny server, never anything else in the build context.
COPY index.html bounty.html verify.html howto.html styles.css tessera-verify.js server.mjs ./
COPY js/ ./js/
COPY test/serve.mjs ./test/serve.mjs
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
