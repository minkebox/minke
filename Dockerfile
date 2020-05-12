FROM alpine:3.11

EXPOSE 53/tcp 53/udp 80/tcp
VOLUME /minke

LABEL net.minkebox.system="true"

ENTRYPOINT ["/startup.sh"]

COPY startup.sh /startup.sh
COPY app/package.json /app/package.json
COPY app/native /app/native
RUN apk add nodejs npm \
    tzdata openntpd e2fsprogs parted \
    iproute2 \
    make gcc g++ python ;\
    cd /app ; npm install --unsafe-perm --production ; apk del npm make gcc g++ python

COPY app/ /app
