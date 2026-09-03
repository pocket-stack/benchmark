# SO3 benchmark profiles

Both files are derived from SO3 commit `e37b1c2a45429bdb5018fc55f748a27f189bc479` and deliberately keep one CPU, the RAM rootfs and PL011 while disabling networking, framebuffer/input devices and SMC911X. This lets stock QEMU run the reference machine without SO3's patched device model or host-timed slirp traffic.

The user-thread stack is explicitly 256 KB. The upstream virt32 default of 64 KB faults in native `deep-32` at roughly 68.6 KB of stack use; 256 KB admits the corpus maximum `deep-64` on both reference profiles. This setting is part of the profile identity and is separate from QuickJS's own 256 KB stack limit.

`ref/build-so3-kernel.sh` copies the selected file into a built SO3 tree only for the duration of `build.sh -x so3`, then restores the tree's config and `local.conf`.
