"""
Master plan #6 regression (static checks, like the other mobile tests): the mobile 3D gallery shows the
vault's real documents and never fabricates evidence.

Before the fix SpatialGyroView always drew four invented documents ("ATO Notice FY24", "Smith Trust Deed", ...)
and App.tsx built a fake citation ("Verified Australian financial evidence excerpt ... APP 8 compliance")
for them. The Gyro / Cardboard toggles also did nothing, because the render loop read their values from a
closure captured once when the GL context was created, and the loop was never stopped.
"""
import re
from pathlib import Path

MOBILE = Path(__file__).resolve().parents[3] / "apps" / "mobile"
VIEW = (MOBILE / "src" / "components" / "SpatialGyroView.tsx").read_text(encoding="utf-8")
APP = (MOBILE / "App.tsx").read_text(encoding="utf-8")


def test_no_placeholder_documents_or_fabricated_citation():
    for invented in ("ATO Notice FY24", "Macquarie Wrap", "AustralianSuper", "Smith Trust Deed"):
        assert invented not in VIEW
    assert "Verified Australian financial evidence" not in APP
    assert "doc_preview" not in APP
    assert "onSelectDocument" not in APP + VIEW


def test_slabs_come_from_the_vaults_documents():
    assert "documents: DocumentRecord[];" in VIEW
    assert re.search(r"shownDocs\.map\(\(doc, i\) => \(\{\s*documentId: doc\.id,", VIEW)
    assert "<SpatialGyroView theme={theme} documents={documents} />" in APP
    # An empty vault says so instead of showing an invented gallery
    assert "shownDocs.length === 0" in VIEW


def test_toggles_reach_the_render_loop_and_the_loop_stops():
    loop = VIEW[VIEW.index("const render = () => {"):VIEW.index("render();\n  };")]
    assert "gyroActiveRef.current" in loop and "stereoModeRef.current" in loop
    assert not re.search(r"if \((gyroActive|stereoMode)\)", loop)
    assert "cancelAnimationFrame(animFrame)" in VIEW
    assert "<GLView key={sceneKey}" in VIEW
