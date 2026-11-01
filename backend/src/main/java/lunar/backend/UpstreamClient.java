package lunar.backend;

import java.util.Map;

/** One call to the upstream Horizons API. Implementations return the raw text response. */
public interface UpstreamClient {
    String fetch(Map<String, String> params) throws Exception;
}
