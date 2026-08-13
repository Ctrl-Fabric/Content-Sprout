"""In-memory export job progress."""

from content_sprout.export_jobs import create_job, find_active_job, get_job, update_job


def test_export_job_lifecycle():
    job = create_job(project_id="p1", post_id="post1", kind="video")
    assert job.status == "queued"
    assert get_job(job.id) is not None
    active = find_active_job("p1", "post1", "video")
    assert active is not None and active.id == job.id

    update_job(job.id, status="running", percent=42.4, message="Scene 1 of 3")
    snap = get_job(job.id)
    assert snap is not None
    body = snap.as_dict()
    assert body["status"] == "running"
    assert body["percent"] == 42.4
    assert body["message"] == "Scene 1 of 3"
    assert body["ready"] is False

    update_job(job.id, status="done", percent=100, message="Done", path="/tmp/out.mp4", filename="out.mp4")
    done = get_job(job.id)
    assert done is not None
    assert done.as_dict()["ready"] is True
    assert find_active_job("p1", "post1", "video") is None
