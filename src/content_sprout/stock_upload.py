"""Upload edited videos to stock contributor destinations.

Stock agencies generally have no public contributor REST upload API. Supported
transports:

- FTPS (e.g. Shutterstock) via stdlib ``ftplib.FTP_TLS``
- SFTP (e.g. Adobe Stock) via optional ``paramiko``
- HTTPS webhook (multipart POST to a URL you control)
- Local submission package (video + CSV metadata + README) for manual portal upload
"""

from __future__ import annotations

import csv
import ftplib
import io
import re
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from .config import StockUploadSite, provider_defaults


class StockUploadError(RuntimeError):
    """Raised when a stock upload destination fails."""


@dataclass
class UploadMeta:
    title: str
    description: str = ""
    keywords: list[str] = field(default_factory=list)
    category: str = ""
    filename: str = ""  # basename for remote / CSV; defaults from video path


@dataclass
class UploadResult:
    site_id: str
    site_name: str
    provider: str
    ok: bool
    message: str
    remote_name: str | None = None
    package_dir: str | None = None
    portal_url: str | None = None
    csv_path: str | None = None


def _safe_basename(name: str, *, fallback: str = "clip.mp4") -> str:
    cleaned = re.sub(r"[^\w.\-]+", "_", (name or "").strip(), flags=re.UNICODE)
    cleaned = cleaned.strip("._") or fallback
    if not Path(cleaned).suffix:
        cleaned = f"{cleaned}.mp4"
    return cleaned[:180]


def _keywords_csv(keywords: list[str]) -> str:
    parts = []
    for k in keywords:
        t = str(k or "").strip()
        if t:
            parts.append(t)
    # Shutterstock style: comma-separated, no surrounding spaces required
    return ", ".join(parts[:50])


def build_shutterstock_csv(meta: UploadMeta, filename: str) -> str:
    """CSV matching Shutterstock contributor metadata columns."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["Filename", "Description", "Keywords", "Categories"])
    desc = (meta.description or meta.title or filename).strip()[:200]
    writer.writerow(
        [
            filename,
            desc,
            _keywords_csv(meta.keywords),
            (meta.category or "").strip(),
        ]
    )
    return buf.getvalue()


def write_submission_package(
    out_dir: Path,
    video_path: Path,
    meta: UploadMeta,
    *,
    site: StockUploadSite | None = None,
) -> tuple[Path, Path]:
    """Copy video + write CSV/README into ``out_dir``. Returns (video_copy, csv_path)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    filename = _safe_basename(meta.filename or video_path.name)
    dest_video = out_dir / filename
    if dest_video.resolve() != video_path.resolve():
        shutil.copy2(video_path, dest_video)

    csv_path = out_dir / "metadata.csv"
    csv_path.write_text(build_shutterstock_csv(meta, filename), encoding="utf-8")

    portal = (site.portal_url if site else "") or ""
    defaults = provider_defaults(site.provider) if site else {}
    if not portal:
        portal = str(defaults.get("portal_url") or "")

    readme = out_dir / "README.txt"
    lines = [
        "Content-Sprout stock submission package",
        f"Created: {datetime.now(tz=timezone.utc).isoformat()}",
        f"Title: {meta.title}",
        f"Video: {filename}",
        "",
        "1. Upload the video file via the agency contributor portal or FTPS/SFTP client.",
        "2. Upload metadata.csv on the Submit page when the site asks for a CSV",
        "   (Shutterstock: do NOT put the CSV on FTPS — use the Submit → CSV button).",
        "",
    ]
    if portal:
        lines.append(f"Portal: {portal}")
        lines.append("")
    if site and site.notes:
        lines.append(f"Notes: {site.notes}")
        lines.append("")
    readme.write_text("\n".join(lines), encoding="utf-8")
    return dest_video, csv_path


def resolve_connection(site: StockUploadSite) -> tuple[str, int]:
    defaults = provider_defaults(site.provider)
    host = (site.host or "").strip() or str(defaults.get("host") or "")
    port = site.port if site.port is not None else defaults.get("port")
    if port is None:
        port = 21 if "ftps" in site.provider else 22
    return host, int(port)


def upload_via_ftps(
    site: StockUploadSite,
    local_path: Path,
    remote_name: str,
) -> None:
    host, port = resolve_connection(site)
    if not host:
        raise StockUploadError("FTPS host is not configured.")
    if not site.username:
        raise StockUploadError("FTPS username is required.")
    if not site.password:
        raise StockUploadError("FTPS password is required.")

    remote_dir = (site.remote_path or "/").strip() or "/"
    ftp = ftplib.FTP_TLS()
    try:
        ftp.connect(host, port, timeout=60)
        ftp.login(site.username, site.password)
        try:
            ftp.prot_p()
        except ftplib.error_perm:
            pass
        if remote_dir not in {"", "/", "."}:
            try:
                ftp.cwd(remote_dir)
            except ftplib.error_perm as exc:
                raise StockUploadError(f"Cannot open remote path {remote_dir!r}: {exc}") from exc
        with local_path.open("rb") as fh:
            ftp.storbinary(f"STOR {remote_name}", fh)
    except StockUploadError:
        raise
    except ftplib.all_errors as exc:
        raise StockUploadError(f"FTPS upload failed: {exc}") from exc
    except OSError as exc:
        raise StockUploadError(f"FTPS connection error: {exc}") from exc
    finally:
        try:
            ftp.quit()
        except Exception:  # noqa: BLE001
            try:
                ftp.close()
            except Exception:  # noqa: BLE001
                pass


def upload_via_sftp(
    site: StockUploadSite,
    local_path: Path,
    remote_name: str,
) -> None:
    try:
        import paramiko
    except ImportError as exc:
        raise StockUploadError(
            "SFTP uploads need the 'paramiko' package. Install with: uv add paramiko"
        ) from exc

    host, port = resolve_connection(site)
    if not host:
        raise StockUploadError("SFTP host is not configured.")
    if not site.username:
        raise StockUploadError("SFTP username is required.")

    key_path = (site.private_key_path or "").strip()
    if not site.password and not key_path:
        raise StockUploadError("SFTP needs a password or private_key_path.")

    transport = None
    sftp = None
    try:
        transport = paramiko.Transport((host, port))
        if key_path:
            pkey = paramiko.RSAKey.from_private_key_file(key_path)
            transport.connect(username=site.username, pkey=pkey)
        else:
            transport.connect(username=site.username, password=site.password)
        sftp = paramiko.SFTPClient.from_transport(transport)
        if sftp is None:
            raise StockUploadError("Could not open SFTP session.")
        remote_dir = (site.remote_path or "/").strip() or "/"
        remote_full = f"{remote_dir.rstrip('/')}/{remote_name}" if remote_dir not in {"/", ""} else remote_name
        sftp.put(str(local_path), remote_full)
    except StockUploadError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise StockUploadError(f"SFTP upload failed: {exc}") from exc
    finally:
        if sftp is not None:
            try:
                sftp.close()
            except Exception:  # noqa: BLE001
                pass
        if transport is not None:
            try:
                transport.close()
            except Exception:  # noqa: BLE001
                pass


def upload_via_webhook(
    site: StockUploadSite,
    local_path: Path,
    meta: UploadMeta,
    *,
    timeout_s: float = 120.0,
) -> None:
    url = (site.webhook_url or "").strip()
    if not url:
        raise StockUploadError("Webhook URL is not configured.")
    headers: dict[str, str] = {}
    if site.webhook_token:
        headers["Authorization"] = f"Bearer {site.webhook_token}"
    data = {
        "title": meta.title,
        "description": meta.description or meta.title,
        "keywords": _keywords_csv(meta.keywords),
        "category": meta.category,
        "site_id": site.id,
        "site_name": site.name,
    }
    try:
        with local_path.open("rb") as fh:
            files = {"file": (local_path.name, fh, "video/mp4")}
            with httpx.Client(timeout=timeout_s, follow_redirects=True) as client:
                r = client.post(url, data=data, files=files, headers=headers)
                if r.status_code >= 400:
                    raise StockUploadError(
                        f"Webhook returned HTTP {r.status_code}: {r.text[:200]}"
                    )
    except StockUploadError:
        raise
    except httpx.HTTPError as exc:
        raise StockUploadError(f"Webhook request failed: {exc}") from exc


def upload_to_site(
    site: StockUploadSite,
    video_path: Path,
    meta: UploadMeta,
    *,
    package_root: Path,
    timeout_s: float = 120.0,
) -> UploadResult:
    """Upload (or package) one video for a single configured site."""
    if not site.enabled:
        return UploadResult(
            site_id=site.id,
            site_name=site.name,
            provider=site.provider,
            ok=False,
            message="Site is disabled in Settings.",
        )
    if not video_path.exists():
        return UploadResult(
            site_id=site.id,
            site_name=site.name,
            provider=site.provider,
            ok=False,
            message=f"Video file missing: {video_path}",
        )

    filename = _safe_basename(meta.filename or f"{meta.title or video_path.stem}.mp4")
    portal = (site.portal_url or "").strip() or str(provider_defaults(site.provider).get("portal_url") or "")
    stamp = datetime.now(tz=timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    pkg_dir = package_root / f"{stamp}_{site.id}_{Path(filename).stem}"[:80]

    try:
        dest_video, csv_path = write_submission_package(pkg_dir, video_path, meta, site=site)

        if site.provider == "package":
            return UploadResult(
                site_id=site.id,
                site_name=site.name,
                provider=site.provider,
                ok=True,
                message="Submission package ready (manual portal upload).",
                remote_name=filename,
                package_dir=str(pkg_dir),
                portal_url=portal or None,
                csv_path=str(csv_path),
            )

        if site.provider in {"shutterstock_ftps", "generic_ftps"}:
            upload_via_ftps(site, dest_video, filename)
            return UploadResult(
                site_id=site.id,
                site_name=site.name,
                provider=site.provider,
                ok=True,
                message="Uploaded via FTPS. Add metadata.csv in the contributor Submit UI if required.",
                remote_name=filename,
                package_dir=str(pkg_dir),
                portal_url=portal or None,
                csv_path=str(csv_path),
            )

        if site.provider in {"adobe_stock_sftp", "generic_sftp"}:
            upload_via_sftp(site, dest_video, filename)
            return UploadResult(
                site_id=site.id,
                site_name=site.name,
                provider=site.provider,
                ok=True,
                message="Uploaded via SFTP. Finish metadata in the contributor portal if needed.",
                remote_name=filename,
                package_dir=str(pkg_dir),
                portal_url=portal or None,
                csv_path=str(csv_path),
            )

        if site.provider == "webhook":
            upload_via_webhook(site, dest_video, meta, timeout_s=timeout_s)
            return UploadResult(
                site_id=site.id,
                site_name=site.name,
                provider=site.provider,
                ok=True,
                message="Posted to webhook.",
                remote_name=filename,
                package_dir=str(pkg_dir),
                portal_url=portal or None,
                csv_path=str(csv_path),
            )

        raise StockUploadError(f"Unknown provider: {site.provider}")
    except StockUploadError as exc:
        return UploadResult(
            site_id=site.id,
            site_name=site.name,
            provider=site.provider,
            ok=False,
            message=str(exc),
            package_dir=str(pkg_dir) if pkg_dir.exists() else None,
            portal_url=portal or None,
        )


def check_site_connection(site: StockUploadSite) -> dict[str, Any]:
    """Lightweight connectivity check (login only; no file transfer)."""
    defaults = provider_defaults(site.provider)
    transport = defaults.get("transport")
    if transport == "package":
        return {"ok": True, "detail": "Package mode needs no connection."}
    if transport == "webhook":
        url = (site.webhook_url or "").strip()
        if not url:
            return {"ok": False, "detail": "Webhook URL is empty."}
        try:
            with httpx.Client(timeout=15.0, follow_redirects=True) as client:
                # Prefer HEAD; some endpoints only allow POST — treat 405 as reachable.
                r = client.head(url)
                if r.status_code == 405:
                    return {"ok": True, "detail": f"Webhook reachable (HTTP {r.status_code})."}
                if r.status_code >= 500:
                    return {"ok": False, "detail": f"Webhook HTTP {r.status_code}"}
                return {"ok": True, "detail": f"Webhook reachable (HTTP {r.status_code})."}
        except httpx.HTTPError as exc:
            return {"ok": False, "detail": str(exc)}

    if transport == "ftps":
        host, port = resolve_connection(site)
        if not host or not site.username or not site.password:
            return {"ok": False, "detail": "FTPS needs host, username, and password."}
        ftp = ftplib.FTP_TLS()
        try:
            ftp.connect(host, port, timeout=20)
            ftp.login(site.username, site.password)
            try:
                ftp.prot_p()
            except ftplib.error_perm:
                pass
            welcome = (ftp.getwelcome() or "").strip()[:120]
            ftp.quit()
            return {"ok": True, "detail": welcome or f"Logged in to {host}:{port}"}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "detail": str(exc)}
        finally:
            try:
                ftp.close()
            except Exception:  # noqa: BLE001
                pass

    if transport == "sftp":
        try:
            import paramiko
        except ImportError:
            return {
                "ok": False,
                "detail": "Install paramiko for SFTP tests: uv add paramiko",
            }
        host, port = resolve_connection(site)
        if not host or not site.username:
            return {"ok": False, "detail": "SFTP needs host and username."}
        if not site.password and not (site.private_key_path or "").strip():
            return {"ok": False, "detail": "SFTP needs password or private_key_path."}
        transport_obj = None
        try:
            transport_obj = paramiko.Transport((host, port))
            key_path = (site.private_key_path or "").strip()
            if key_path:
                pkey = paramiko.RSAKey.from_private_key_file(key_path)
                transport_obj.connect(username=site.username, pkey=pkey)
            else:
                transport_obj.connect(username=site.username, password=site.password)
            return {"ok": True, "detail": f"Logged in to {host}:{port}"}
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "detail": str(exc)}
        finally:
            if transport_obj is not None:
                try:
                    transport_obj.close()
                except Exception:  # noqa: BLE001
                    pass

    return {"ok": False, "detail": f"Unsupported transport for {site.provider}"}
