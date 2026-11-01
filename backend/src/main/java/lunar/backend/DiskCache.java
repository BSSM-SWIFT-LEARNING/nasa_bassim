package lunar.backend;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/** Raw Horizons responses cached on disk; a hit never calls upstream. */
public class DiskCache {
    private final Path dir;

    public DiskCache(Path dir) {
        this.dir = dir;
    }

    public String get(String key) {
        Path path = pathFor(key);
        try {
            return Files.exists(path) ? Files.readString(path) : null;
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    public void put(String key, String text) {
        try {
            Files.createDirectories(dir);
            Files.writeString(pathFor(key), text);
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private Path pathFor(String key) {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        String hash = HexFormat.of().formatHex(md.digest(key.getBytes(StandardCharsets.UTF_8)));
        return dir.resolve(hash.substring(0, 16) + ".txt");
    }
}
