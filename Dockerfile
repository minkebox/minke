FROM alpine:latest

RUN apk add nodejs npm \
    dnsmasq tzdata openntpd e2fsprogs parted dnscrypt-proxy ;\
    mkdir -p /etc/dnshosts.d

COPY startup.sh /startup.sh

COPY app/ /app
RUN cd /app ; npm install --production ; apk del npm


EXPOSE 53/tcp 53/udp 80/tcp
VOLUME /minke/db /minke/apps /app/skeletons/local /app/skeletons/internal

LABEL net.minkebox.system="true"

ENTRYPOINT ["/startup.sh"]
