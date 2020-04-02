FROM alpine:3.11

EXPOSE 53/tcp 53/udp 80/tcp
VOLUME /minke

LABEL net.minkebox.system="true"

ENTRYPOINT ["/startup.sh"]

COPY startup.sh /startup.sh
COPY app/package.json /app/package.json
RUN apk add nodejs npm \
    tzdata openntpd e2fsprogs parted ;\
    cd /app ; npm install --production ; apk del npm

COPY app/ /app
