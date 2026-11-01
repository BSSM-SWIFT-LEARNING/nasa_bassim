package lunar.backend;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

@Service
public class EphemerisService {
    private final DiskCache cache;
    private final HorizonsQueue queue;
    private final ConcurrentHashMap<String, CompletableFuture<String>> inFlight = new ConcurrentHashMap<>();

    @Autowired
    public EphemerisService(
            @Value("${ephemeris.cache-dir:cache}") String cacheDir,
            UpstreamClient upstream) {
        this(new DiskCache(java.nio.file.Path.of(cacheDir)),
                new HorizonsQueue(upstream, Horizons.REQUEST_INTERVAL_MILLIS));
    }

    /** For tests: inject the queue and cache. */
    EphemerisService(DiskCache cache, HorizonsQueue queue) {
        this.cache = cache;
        this.queue = queue;
    }

    public Map<String, Object> ephemeris(Double lat, Double lonE, String body) {
        if (lat == null || lat < -90 || lat > 90 || lat.isNaN()) {
            throw new BadRequestException("lat must be a number in [-90, 90]");
        }
        if (lonE == null || lonE < -360 || lonE > 360 || lonE.isNaN()) {
            throw new BadRequestException("lon_e must be a number in [-360, 360]");
        }
        if (!"sun".equals(body) && !"earth".equals(body)) {
            throw new BadRequestException("body must be 'sun' or 'earth'");
        }
        double rLat = round4(lat);
        double rLon = round4(lonE);
        String bodyCode = "sun".equals(body) ? Horizons.SUN : Horizons.EARTH;
        Map<String, String> params = Horizons.requestParams(
                bodyCode, rLon, rLat, Horizons.START, Horizons.STOP, Horizons.STEP);
        String key = cacheKey(body, rLat, rLon);

        String text = cache.get(key);
        if (text == null) {
            CompletableFuture<String> future = inFlight.computeIfAbsent(key, k -> {
                // Re-check under the inFlight lock: another request may have
                // finished its upstream call and cached the result since our
                // cache.get above missed.
                String cached = cache.get(key);
                return cached != null
                        ? CompletableFuture.completedFuture(cached)
                        : queue.submit(params);
            });
            try {
                text = future.get();
                // Parse before caching: never cache an error or unparseable response.
                Horizons.parseTable(text);
                // Publish to the cache before clearing inFlight so a request
                // that missed cache.get just before this put still finds the
                // result via the inFlight future or the re-check above.
                cache.put(key, text);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new HorizonsException("interrupted waiting for Horizons", e);
            } catch (ExecutionException e) {
                throw upstreamFailure(e.getCause());
            } finally {
                inFlight.remove(key, future);
            }
        }

        List<Horizons.Sample> samples = Horizons.parseTable(text);
        Map<String, Object> doc = new LinkedHashMap<>();
        doc.put("site", "custom");
        doc.put("name", "직접 입력 좌표");
        doc.put("body", body);
        doc.put("lat", rLat);
        doc.put("lon_e", rLon);
        doc.put("source", Horizons.signature(text));
        List<Map<String, Object>> rows = new ArrayList<>(samples.size());
        for (Horizons.Sample s : samples) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("t", s.time().toString());
            row.put("az", s.azimuthDeg());
            row.put("el", s.elevationDeg());
            row.put("flags", s.flags());
            rows.add(row);
        }
        doc.put("samples", rows);
        return doc;
    }

    static double round4(double v) {
        return BigDecimal.valueOf(v).setScale(4, RoundingMode.HALF_UP).doubleValue();
    }

    static String cacheKey(String body, double lat, double lonE) {
        return body + "|" + lat + "|" + lonE;
    }

    private static HorizonsException upstreamFailure(Throwable cause) {
        if (cause instanceof HorizonsException he) return he;
        String msg = cause == null ? "unknown" : cause.getMessage();
        return new HorizonsException("Horizons request failed: " + msg, cause);
    }
}
