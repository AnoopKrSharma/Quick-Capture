import { useEffect, useMemo, useState } from "react";
import { Document, ImageRun, Packer, Paragraph, TextRun } from "docx";
import PptxGenJS from "pptxgenjs";
import { addShot, clearShots, getAllShots, getSession, getShotCount, setSession } from "./persist";

const FILE_TYPE = {
  WORD: "word",
  PPT: "ppt"
};

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

async function captureCurrentTab() {
  return new Promise((resolve, reject) => {
    // Captures only visible viewport of the currently active tab.
    chrome.tabs.captureVisibleTab(
      undefined,
      {
        format: "png"
      },
      (dataUrl) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(dataUrl);
      }
    );
  });
}

async function getActiveTabUrl() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const err = chrome.runtime.lastError;
      if (err) {
        resolve("URL unavailable");
        return;
      }
      resolve(tabs?.[0]?.url || "URL unavailable");
    });
  });
}

async function dataUrlToArrayBuffer(dataUrl) {
  const response = await fetch(dataUrl);
  return response.arrayBuffer();
}

function getPngSize(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  // PNG IHDR chunk stores width/height at fixed offsets.
  if (bytes.length < 24) {
    return { width: 1200, height: 675 };
  }
  const view = new DataView(arrayBuffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height) {
    return { width: 1200, height: 675 };
  }
  return { width, height };
}

function fitInside(width, height, maxWidth, maxHeight) {
  const imageAspect = width / height;
  const boxAspect = maxWidth / maxHeight;
  if (imageAspect >= boxAspect) {
    return {
      width: Number(maxWidth.toFixed(2)),
      height: Number((maxWidth / imageAspect).toFixed(2))
    };
  }
  return {
    width: Number((maxHeight * imageAspect).toFixed(2)),
    height: Number(maxHeight.toFixed(2))
  };
}

async function downloadBlob(blob, filename, mimeType) {
  const payload = mimeType ? new Blob([blob], { type: mimeType }) : blob;
  const url = URL.createObjectURL(payload);
  await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs: false
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve();
      }
    );
  });
}

async function generateWordFile(images) {
  // Convert data URLs first so docx gets valid binary image payloads.
  const imageBuffers = await Promise.all(images.map((img) => dataUrlToArrayBuffer(img.dataUrl)));
  const children = [];
  imageBuffers.forEach((buffer, idx) => {
    const pageUrl = images[idx]?.pageUrl || "URL unavailable";
    const pngSize = getPngSize(buffer);
    // Keep screenshot ratio while fitting image into document width.
    const wordSize = fitInside(pngSize.width, pngSize.height, 600, 700);
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: pageUrl,
            size: 20
          })
        ]
      })
    );
    children.push(
      new Paragraph({
        children: [
          new ImageRun({
            type: "png",
            data: buffer,
            transformation: {
              width: wordSize.width,
              height: wordSize.height
            }
          })
        ]
      })
    );
  });

  const doc = new Document({
    sections: [
      {
        children
      }
    ]
  });

  return Packer.toBlob(doc);
}

async function generatePptFile(images) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";

  images.forEach((img) => {
    // One screenshot per slide with source URL on top.
    const slide = pptx.addSlide();
    const pngSize = getPngSize(
      // Convert from data URL to read native dimensions for ratio-safe sizing.
      Uint8Array.from(atob((img.dataUrl.split(",")[1] || "").replace(/\s/g, "")), (c) => c.charCodeAt(0))
        .buffer
    );
    const fitted = fitInside(pngSize.width, pngSize.height, 13.1, 6.8);
    const imageX = 0.1 + (13.1 - fitted.width) / 2;
    slide.addText(img.pageUrl || "URL unavailable", {
      x: 0.2,
      y: 0.1,
      w: 12.8,
      h: 0.3,
      fontSize: 11,
      color: "1F2937"
    });
    slide.addImage({
      data: img.dataUrl,
      x: imageX,
      y: 0.5,
      w: fitted.width,
      h: fitted.height
    });
  });

  return pptx.write({ outputType: "blob" });
}

export default function App() {
  const [shotCount, setShotCount] = useState(0);
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  const [fileType, setFileType] = useState(FILE_TYPE.WORD);

  const isEmpty = shotCount === 0;
  const counterLabel = useMemo(() => {
    return `${shotCount} screenshot${shotCount === 1 ? "" : "s"}`;
  }, [shotCount]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Hydrate popup from persisted session when reopened.
        const session = await getSession();
        const count = await getShotCount();
        if (cancelled) return;
        setIsSessionActive(!!session.active);
        setFileType(session.fileType || FILE_TYPE.WORD);
        setShotCount(count);
      } catch {
        // If persistence fails for any reason, fall back to fresh UI state.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const withBusy = async (fn) => {
    setError("");
    setIsBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e?.message || "Something went wrong.");
    } finally {
      setIsBusy(false);
    }
  };

  const handleStartCapture = async () => {
    await withBusy(async () => {
      if (isSessionActive) return;
      // Start a brand-new session and take first screenshot immediately.
      const firstShot = await captureCurrentTab();
      const pageUrl = await getActiveTabUrl();
      await clearShots();
      await addShot({ dataUrl: firstShot, pageUrl });
      await setSession({ active: true, fileType });
      setShotCount(1);
      setIsSessionActive(true);
    });
  };

  const handleCapture = async () => {
    await withBusy(async () => {
      if (!isSessionActive) {
        throw new Error("Click Start Capture first.");
      }
      // Append to existing session without resetting previous captures.
      const nextShot = await captureCurrentTab();
      const pageUrl = await getActiveTabUrl();
      await addShot({ dataUrl: nextShot, pageUrl });
      setShotCount((c) => c + 1);
    });
  };

  const handleEnd = async () => {
    await withBusy(async () => {
      if (!isSessionActive || isEmpty) {
        throw new Error("No screenshots to export.");
      }

      // Build final document from all persisted shots, then reset session.
      const images = await getAllShots();
      const stamp = timestamp();
      if (fileType === FILE_TYPE.WORD) {
        const blob = await generateWordFile(images);
        await downloadBlob(
          blob,
          `quick-capture-${stamp}.docx`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
      } else {
        const blob = await generatePptFile(images);
        await downloadBlob(
          blob,
          `quick-capture-${stamp}.pptx`,
          "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        );
      }

      await clearShots();
      await setSession({ active: false, fileType });
      setShotCount(0);
      setIsSessionActive(false);
    });
  };

  return (
    <main className="app">
      <h1>Quick Capture</h1>
      <p className="subtitle">Capture screenshots fast and export at the end.</p>

      <div className="card">
        <label htmlFor="fileType">Export format</label>
        <select
          id="fileType"
          value={fileType}
          onChange={(e) => {
            const next = e.target.value;
            setFileType(next);
            if (isSessionActive) {
              setSession({ active: true, fileType: next }).catch(() => {});
            }
          }}
          disabled={isBusy || isSessionActive}
        >
          <option value={FILE_TYPE.WORD}>Word (.docx)</option>
          <option value={FILE_TYPE.PPT}>PowerPoint (.pptx)</option>
        </select>
      </div>

      <div className="counter">{counterLabel}</div>

      <div className="buttonRow">
        <button onClick={handleStartCapture} disabled={isBusy || isSessionActive}>
          Start Capture
        </button>
        <button onClick={handleCapture} disabled={isBusy || !isSessionActive}>
          Capture
        </button>
        <button onClick={handleEnd} disabled={isBusy || !isSessionActive || isEmpty}>
          End & Download
        </button>
      </div>

      {isBusy && <p className="info">Working...</p>}
      {!!error && <p className="error">{error}</p>}
    </main>
  );
}
