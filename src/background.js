import { Document, ImageRun, Packer, Paragraph, TextRun } from "docx";
import PptxGenJS from "pptxgenjs";
import { addShot, clearShots, getAllShots, getSession, setSession } from "./persist";

const FILE_TYPE = {
  WORD: "word",
  PPT: "ppt"
};
const CAPTURE_MIN_INTERVAL_MS = 1200;
let lastCaptureAt = 0;

function showNotification(title, message, iconPath = null) {
  const options = {
    type: "basic",
    title: title,
    message: message,
    iconUrl: iconPath || chrome.runtime.getURL("images/icon-128.png")
  };
  
  chrome.notifications.create("quick-capture-notification", options, (notificationId) => {
    // Auto-clear notification after 4 seconds
    setTimeout(() => {
      chrome.notifications.clear(notificationId).catch(() => {});
    }, 4000);
  });
}

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureCurrentTab() {
  const waitMs = Math.max(0, CAPTURE_MIN_INTERVAL_MS - (Date.now() - lastCaptureAt));
  if (waitMs > 0) {
    await sleep(waitMs);
  }

  try {
    const dataUrl = await new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(undefined, { format: "png" }, (nextDataUrl) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(new Error(err.message));
          return;
        }
        resolve(nextDataUrl);
      });
    });
    lastCaptureAt = Date.now();
    return dataUrl;
  } catch (error) {
    if ((error?.message || "").includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")) {
      await sleep(CAPTURE_MIN_INTERVAL_MS);
      return captureCurrentTab();
    }
    throw error;
  }
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
  
  // Convert blob to data URL for Service Worker context
  const arrayBuffer = await payload.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);
  let binaryString = '';
  for (let i = 0; i < uint8Array.length; i++) {
    binaryString += String.fromCharCode(uint8Array[i]);
  }
  const base64 = btoa(binaryString);
  const url = `data:${payload.type || 'application/octet-stream'};base64,${base64}`;
  
  await new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false }, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve();
    });
  });
}

async function generateWordFile(images) {
  const imageBuffers = await Promise.all(images.map((img) => dataUrlToArrayBuffer(img.dataUrl)));
  const children = [];
  imageBuffers.forEach((buffer, idx) => {
    const pageUrl = images[idx]?.pageUrl || "URL unavailable";
    const pngSize = getPngSize(buffer);
    const wordSize = fitInside(pngSize.width, pngSize.height, 600, 700);
    children.push(
      new Paragraph({
        children: [new TextRun({ text: pageUrl, size: 20 })]
      })
    );
    children.push(
      new Paragraph({
        children: [
          new ImageRun({
            type: "png",
            data: buffer,
            transformation: { width: wordSize.width, height: wordSize.height }
          })
        ]
      })
    );
  });

  const doc = new Document({
    sections: [{ children }]
  });
  return Packer.toBlob(doc);
}

async function generatePptFile(images) {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  images.forEach((img) => {
    const slide = pptx.addSlide();
    const pngSize = getPngSize(
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

async function startCaptureFromShortcut() {
  try {
    const session = await getSession();
    if (session.active) {
      showNotification("Quick Capture", "Capture session already active.");
      chrome.runtime.sendMessage({ 
        type: "notification", 
        message: "Capture session already active." 
      }).catch(() => {});
      return;
    }
    const firstShot = await captureCurrentTab();
    const pageUrl = await getActiveTabUrl();
    await clearShots();
    await addShot({ dataUrl: firstShot, pageUrl });
    await setSession({ active: true, fileType: session.fileType || FILE_TYPE.WORD });
    showNotification("Quick Capture", "✓ Capture started! First screenshot captured.");
    chrome.runtime.sendMessage({ 
      type: "notification", 
      message: "Capture started! First screenshot captured." 
    }).catch(() => {});
  } catch (error) {
    console.error("Start capture failed:", error);
    showNotification("Quick Capture", `✗ Capture failed: ${error?.message || "Unknown error"}`);
    chrome.runtime.sendMessage({ 
      type: "notification", 
      message: `Capture failed: ${error?.message || "Unknown error"}` 
    }).catch(() => {});
  }
}

async function addCaptureFromShortcut() {
  try {
    const session = await getSession();
    if (!session.active) {
      showNotification("Quick Capture", "No active session. Press Ctrl+Shift+Y to start capture.");
      chrome.runtime.sendMessage({ 
        type: "notification", 
        message: "No active session. Press Ctrl+Shift+Y to start capture." 
      }).catch(() => {});
      return;
    }
    const shot = await captureCurrentTab();
    const pageUrl = await getActiveTabUrl();
    await addShot({ dataUrl: shot, pageUrl });
    showNotification("Quick Capture", "✓ Screenshot captured!");
    chrome.runtime.sendMessage({ 
      type: "notification", 
      message: "Screenshot captured!" 
    }).catch(() => {});
  } catch (error) {
    console.error("Add capture failed:", error);
    showNotification("Quick Capture", `✗ Capture failed: ${error?.message || "Unknown error"}`);
    chrome.runtime.sendMessage({ 
      type: "notification", 
      message: `Capture failed: ${error?.message || "Unknown error"}` 
    }).catch(() => {});
  }
}

async function endCaptureFromShortcut() {
  try {
    const session = await getSession();
    if (!session.active) {
      showNotification("Quick Capture", "No active session. Start capture first.");
      chrome.runtime.sendMessage({ 
        type: "notification", 
        message: "No active session. Start capture first." 
      }).catch(() => {});
      return;
    }
    const images = await getAllShots();
    if (!images.length) {
      showNotification("Quick Capture", "No screenshots to export.");
      chrome.runtime.sendMessage({ 
        type: "notification", 
        message: "No screenshots to export." 
      }).catch(() => {});
      return;
    }
    const stamp = timestamp();
    if ((session.fileType || FILE_TYPE.WORD) === FILE_TYPE.WORD) {
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
    await setSession({ active: false, fileType: session.fileType || FILE_TYPE.WORD });
    showNotification("Quick Capture", "✓ Screenshot(s) exported successfully!");
    chrome.runtime.sendMessage({ 
      type: "notification", 
      message: "Screenshot(s) exported successfully!" 
    }).catch(() => {});
  } catch (error) {
    console.error("End capture failed:", error);
    showNotification("Quick Capture", `✗ Export failed: ${error?.message || "Unknown error"}`);
    chrome.runtime.sendMessage({ 
      type: "notification", 
      message: `Export failed: ${error?.message || "Unknown error"}` 
    }).catch(() => {});
  }
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("Quick Screenshot Capture installed");
});

async function toggleFormat() {
  try {
    const session = await getSession();
    const currentFormat = session.fileType || FILE_TYPE.PPT;
    const newFileType = currentFormat === FILE_TYPE.WORD ? FILE_TYPE.PPT : FILE_TYPE.WORD;
    await setSession({ active: session.active, fileType: newFileType });
    const formatName = newFileType === FILE_TYPE.WORD ? "Word (.docx)" : "PowerPoint (.pptx)";
    showNotification("Quick Capture", `✓ Format switched to ${formatName}`);
    chrome.runtime.sendMessage({ 
      type: "notification", 
      message: `Export format switched to ${formatName}. Screenshots will be saved as ${newFileType}.` 
    }).catch(() => {});
  } catch (error) {
    console.error("Toggle format failed:", error);
    showNotification("Quick Capture", `✗ Format switch failed: ${error?.message || "Unknown error"}`);
    chrome.runtime.sendMessage({ 
      type: "notification", 
      message: `Format switch failed: ${error?.message || "Unknown error"}` 
    }).catch(() => {});
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === "start-capture") {
      await startCaptureFromShortcut();
    } else if (command === "capture-shot") {
      await addCaptureFromShortcut();
    } else if (command === "finish-capture-download") {
      await endCaptureFromShortcut();
    } else if (command === "toggle-format") {
      await toggleFormat();
    }
  } catch (error) {
    console.error("Shortcut action failed:", error);
  }
});
