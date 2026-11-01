package lunar.backend;

import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * All upstream Horizons calls go through this single worker so calls stay
 * sequential with at least {@code intervalMillis} between the end of one call
 * and the start of the next, including under concurrent requests.
 */
public class HorizonsQueue implements AutoCloseable {
    private record Task(Map<String, String> params, CompletableFuture<String> result) {}

    private final BlockingQueue<Task> queue = new LinkedBlockingQueue<>();
    private final UpstreamClient upstream;
    private final long intervalMillis;
    private final Thread worker;
    private volatile boolean closed;

    public HorizonsQueue(UpstreamClient upstream, long intervalMillis) {
        this.upstream = upstream;
        this.intervalMillis = intervalMillis;
        this.worker = Thread.ofVirtual().start(this::run);
    }

    public CompletableFuture<String> submit(Map<String, String> params) {
        CompletableFuture<String> result = new CompletableFuture<>();
        queue.add(new Task(Map.copyOf(params), result));
        return result;
    }

    private void run() {
        long lastCallEnd = Long.MIN_VALUE / 2;
        while (!closed || !queue.isEmpty()) {
            Task task;
            try {
                task = queue.take();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
            long wait = intervalMillis - (System.currentTimeMillis() - lastCallEnd);
            if (wait > 0) {
                try {
                    Thread.sleep(wait);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    task.result.completeExceptionally(e);
                    return;
                }
            }
            try {
                task.result.complete(upstream.fetch(task.params()));
            } catch (Throwable t) {
                task.result.completeExceptionally(t);
            } finally {
                lastCallEnd = System.currentTimeMillis();
            }
        }
    }

    @Override
    public void close() {
        closed = true;
        worker.interrupt();
    }

}
