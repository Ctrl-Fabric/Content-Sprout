"""Watch-folder daemon — debounced auto-processing with triage folders."""

from __future__ import annotations

import os
import queue
import shutil
import signal
import threading
import time
import traceback
from pathlib import Path

from rich.console import Console
from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from . import io
from . import processing_state
from .cache import DecisionCache
from .config import AppConfig, WatchConfig, llm_provider_label
from .pipeline import LogoAssets, process_one, resolve_logos
from .router import PlacementRouter

console = Console()

TRIAGE_DONE = ".done"
TRIAGE_FAILED = ".failed"

_SENTINEL = Path("__stop__")  # marker placed on the queue to signal shutdown


def _is_triage_path(path: Path) -> bool:
    return TRIAGE_DONE in path.parts or TRIAGE_FAILED in path.parts


def file_is_settled(path: Path, checks: int, interval_s: float) -> bool:
    """True when file size is unchanged across `checks` consecutive reads."""
    if not path.is_file():
        return False
    try:
        prev = path.stat().st_size
    except OSError:
        return False
    for _ in range(checks - 1):
        time.sleep(interval_s)
        try:
            cur = path.stat().st_size
        except OSError:
            return False
        if cur != prev:
            prev = cur
            return False
    return True


def _move_preserving_tree(src: Path, dest: Path) -> bool:
    """Move `src` to `dest`. Returns False if `src` vanished (race with another mover)."""
    if not src.exists():
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        try:
            dest.unlink()
        except OSError:
            pass
    try:
        shutil.move(str(src), str(dest))
    except FileNotFoundError:
        return False
    return True


def _pid_alive(pid: int) -> bool:
    """True if `pid` is a live process. Signal 0 just checks for existence."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _acquire_watcher_lock(cache_dir: Path) -> Path | None:
    """Refuse to start if another live `content-sprout watch` is already running.

    Returns the lock file path on success so the caller can release it.
    Calls `console.print` + `SystemExit(1)` on conflict.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    lock = cache_dir / "watcher.pid"
    if lock.exists():
        try:
            existing = int(lock.read_text().strip())
        except (ValueError, OSError):
            existing = 0
        if existing and existing != os.getpid() and _pid_alive(existing):
            console.print(
                f"[red]✗ Another `content-sprout watch` is already running (pid {existing}).[/red]"
            )
            console.print(
                "  Two watchers race on the same input/ folder — each file gets"
            )
            console.print(
                "  processed twice and one of them crashes on the move-to-.done step."
            )
            console.print()
            console.print("  Fix it: stop the other watcher (Ctrl+C in that terminal).")
            console.print(f"  Stale lock? Delete [bold]{lock}[/bold] and retry.")
            raise SystemExit(1)
    lock.write_text(str(os.getpid()))
    return lock


class _DebouncedHandler(FileSystemEventHandler):
    """Watch-folder handler with debounced scheduling and a single worker thread.

    Design:
      - File-system events get debounced per-path so rapid bursts of writes
        only trigger one pipeline run.
      - When debounce fires, the path is *enqueued* onto a single-consumer
        queue. A dedicated worker thread drains the queue serially, so only
        one image is processed at a time. This avoids CPU thrash, contention
        on the Ollama model, and races on the move-to-.done step.
    """

    def __init__(
        self,
        input_dir: Path,
        cfg: AppConfig,
        logos: LogoAssets | None,
        router: PlacementRouter,
        watch_cfg: WatchConfig,
    ):
        super().__init__()
        self._input_dir = input_dir.resolve()
        self._cfg = cfg
        self._logos = logos
        self._router = router
        self._watch_cfg = watch_cfg
        self._timers: dict[str, threading.Timer] = {}
        self._lock = threading.Lock()
        self._queue: queue.Queue[Path] = queue.Queue()
        self._stop = threading.Event()
        self._worker = threading.Thread(
            target=self._worker_loop, name="content-sprout-worker", daemon=True
        )
        self._worker.start()

    def stop(self) -> None:
        """Signal the worker to exit at its next idle break."""
        self._stop.set()
        self._queue.put(_SENTINEL)

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            try:
                path = self._queue.get(timeout=0.5)
            except queue.Empty:
                continue
            if path is _SENTINEL:
                return
            try:
                self._process(path)
            except Exception:
                # Never let a per-file failure kill the worker — log + keep going.
                console.print("[red]Worker error (continuing):[/red]")
                console.print(traceback.format_exc())

    def _schedule(self, path: Path) -> None:
        key = str(path.resolve())
        with self._lock:
            old = self._timers.pop(key, None)
            if old is not None:
                old.cancel()
            timer = threading.Timer(
                self._watch_cfg.debounce_s,
                self._enqueue,
                args=(path,),
            )
            timer.daemon = True
            self._timers[key] = timer
            timer.start()

    def _enqueue(self, path: Path) -> None:
        with self._lock:
            self._timers.pop(str(path.resolve()), None)
        self._queue.put(path)

    def on_created(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        self._maybe_schedule(Path(event.src_path))

    def on_moved(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        self._maybe_schedule(Path(event.dest_path))

    def _maybe_schedule(self, path: Path) -> None:
        path = path.resolve()
        if path.suffix.lower() not in io.SUPPORTED_EXT:
            return
        try:
            path.relative_to(self._input_dir)
        except ValueError:
            return
        if _is_triage_path(path):
            return
        self._schedule(path)

    def _process(self, path: Path) -> None:
        path = path.resolve()
        if not path.exists() or _is_triage_path(path):
            return
        if not file_is_settled(
            path,
            self._watch_cfg.settle_checks,
            self._watch_cfg.settle_interval_s,
        ):
            console.print(f"[yellow]skip[/yellow] {path.name} (still being written)")
            return

        rel = path.relative_to(self._input_dir)
        rel_display = str(rel)
        out_base = self._cfg.output_dir / rel.parent / path.stem
        done_root = self._input_dir / TRIAGE_DONE
        failed_root = self._input_dir / TRIAGE_FAILED

        console.print(f"[bold]→[/bold] {rel}")
        processing_state.mark_start(self._cfg.cache_dir, rel_display)
        try:
            try:
                process_one(
                    path,
                    self._cfg,
                    out_base,
                    logos=self._logos,
                    router=self._router,
                    source_rel=rel_display,
                    quiet=False,
                )
            except FileNotFoundError:
                console.print(f"  [dim]·[/dim] source vanished mid-pipeline; skipping")
                return
            except Exception as exc:
                dest = failed_root / rel
                try:
                    moved = _move_preserving_tree(path, dest)
                    if moved:
                        err_path = dest.with_suffix(dest.suffix + ".error.txt")
                        err_path.write_text(
                            f"{type(exc).__name__}: {exc}\n\n{traceback.format_exc()}",
                            encoding="utf-8",
                        )
                        console.print(f"  [red]✗[/red] failed → {dest.relative_to(self._input_dir)}")
                    else:
                        console.print(f"  [red]✗[/red] failed (source vanished): {type(exc).__name__}: {exc}")
                except Exception as move_exc:
                    console.print(
                        f"  [red]✗[/red] failed: {type(exc).__name__}: {exc} "
                        f"(also couldn't move to .failed/: {move_exc})"
                    )
                return

            dest = done_root / rel
            if _move_preserving_tree(path, dest):
                console.print(f"  [green]✓[/green] done → {dest.relative_to(self._input_dir)}")
            else:
                console.print(f"  [dim]·[/dim] processed but source already moved (race); output is fine")
        finally:
            processing_state.mark_done(self._cfg.cache_dir, rel_display)


def run_watch(cfg: AppConfig) -> None:
    """Block forever, processing new images dropped into `cfg.input_dir`."""
    input_dir = cfg.input_dir.resolve()
    input_dir.mkdir(parents=True, exist_ok=True)
    (input_dir / TRIAGE_DONE).mkdir(exist_ok=True)
    (input_dir / TRIAGE_FAILED).mkdir(exist_ok=True)

    lock_path = _acquire_watcher_lock(cfg.cache_dir)

    logos = resolve_logos(cfg)
    cache = DecisionCache(cfg.cache_dir / "decisions.jsonl")
    router = PlacementRouter(cfg, cache=cache)
    processing_state.clear_all(cfg.cache_dir)

    if logos is None:
        console.print("[yellow]Warning:[/yellow] logo PNGs missing — no watermark.")
    else:
        console.print(f"[green]Logos loaded[/green] · LLM fallback: {llm_provider_label(cfg)}")

    console.print(
        f"[bold]Watching[/bold] {input_dir} "
        f"(debounce {cfg.watch.debounce_s}s, Ctrl+C to stop)"
    )
    console.print(f"  Processed → {TRIAGE_DONE}/   Failed → {TRIAGE_FAILED}/")

    handler = _DebouncedHandler(input_dir, cfg, logos, router, cfg.watch)
    observer = Observer()
    observer.schedule(handler, str(input_dir), recursive=True)
    observer.start()

    # Translate SIGTERM (sent by `start-ui.sh`'s pkill on Ctrl+C) into a
    # KeyboardInterrupt so the finally: block runs and the lock is released.
    def _term_to_kbd(signum, frame):  # noqa: ARG001
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, _term_to_kbd)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        console.print("\n[dim]Stopping watch…[/dim]")
    finally:
        observer.stop()
        observer.join()
        handler.stop()
        if lock_path is not None:
            try:
                if lock_path.exists() and lock_path.read_text().strip() == str(os.getpid()):
                    lock_path.unlink()
            except OSError:
                pass
