FROM alpine:edge

COPY app/ /app

RUN apk --no-cache add nodejs nodejs-npm dnsmasq
RUN cd /app ; npm install

EXPOSE 53/tcp 53/udp 8080/tcp
VOLUME /minke

ENTRYPOINT ["/app/index.js"]
