FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS builder
ENV DEBIAN_FRONTEND=noninteractive
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    linux-image-${TARGETARCH} initramfs-tools e2fsprogs coreutils passwd strace tar util-linux iproute2 \
    && useradd --uid 10001 --create-home --home-dir /home/pkgxray --shell /usr/sbin/nologin pkgxray \
    && rm -rf /var/lib/apt/lists/*
COPY services/resolver-worker/container/runner.mjs services/resolver-worker/container/vm-probes.mjs /opt/pkgxray/
COPY services/local-vm/vm-init services/local-vm/guest.mjs /opt/pkgxray/
RUN chmod 0555 /opt/pkgxray/* && mkdir -p /work /out /rootfs \
    && printf 'virtio_console\nvirtio_blk\next4\n' >> /etc/initramfs-tools/modules \
    && kernel=$(basename /lib/modules/*) \
    && mkinitramfs -o /out/initrd "$kernel" \
    && cp /boot/vmlinuz-* /out/kernel \
    && tar -C / --exclude=./proc --exclude=./sys --exclude=./dev --exclude=./boot \
       --exclude=./lib/modules --exclude=./usr/lib/modules --exclude=./out --exclude=./rootfs -cf - . \
       | tar -C /rootfs -xf -
RUN mkdir -p /rootfs/proc /rootfs/sys /rootfs/dev /rootfs/boot \
    && printf 'nameserver 127.0.0.53\noptions timeout:1 attempts:1\n' > /rootfs/etc/resolv.conf \
    && truncate -s 384M /out/root.ext4 \
    && mkfs.ext4 -q -F -d /rootfs /out/root.ext4
FROM scratch
COPY --from=builder /out/ /
