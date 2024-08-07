// =====================================================================================
// Set up listeners for messages from server
// =====================================================================================

function chatMessagesContainer() {
  return document.getElementById("chat");
}

// TODO: Replace this with Shiny.initializePromise when that lands in Shiny for Python
$(document).on("shiny:sessioninitialized", function (event) {
  setTimeout(() => {
    // When the user clicks on the send button, request the latest version of the files
    // from the shinylive iframe. This communication is async, so the file contents will
    // arrive later on the server side than the user chat message.
    messageTriggerCounter = 0;
    chatMessagesContainer().addEventListener(
      "shiny-chat-input-sent",
      async (e) => {
        const fileContents = await requestFileContentsFromWindow();
        Shiny.setInputValue("editor_code", fileContents, {
          priority: "event",
        });
        // This can be removed once we fix
        // https://github.com/posit-dev/py-shiny/issues/1600
        Shiny.setInputValue("message_trigger", messageTriggerCounter++);
      }
    );

    // Receive custom message with app code and send to the shinylive panel.
    Shiny.addCustomMessageHandler("set-shinylive-content", async (message) => {
      // await shinyliveReadyPromise;
      sendFileContentsToWindow(message.files);
    });

    // Receive custom message to show the shinylive panel
    Shiny.addCustomMessageHandler("show-shinylive-panel", (message) => {
      if (message.show === true) {
        showShinylivePanel(message.smooth);
      }
    });
  }, 100);
});

// Listener for "Run code" buttons.
document.addEventListener("click", (e) => {
  if (e.target.matches(".run-code-button")) {
    sendThisShinyappToWindow(e.target);
  }
});

// =====================================================================================
// Functions for sending/requesting files from shinylive panel
// =====================================================================================

// This should be called from a button inside of the .assistant-shinyapp div. It will
// send the files inside of that div to the shinylive panel.
function sendThisShinyappToWindow(buttonEl) {
  const shinyappTag = buttonEl.closest(".assistant-shinyapp");
  const fileTags = shinyappTag.querySelectorAll(".assistant-shinyapp-file");

  const files = Array.from(fileTags).map((fileTag) => {
    return {
      name: fileTag.querySelector(".filename").innerText,
      content: fileTag.querySelector("pre").textContent,
      type: "text",
    };
  });

  sendFileContentsToWindow(files);
}

function sendFileContentsToWindow(fileContents) {
  document.getElementById("shinylive-panel").contentWindow.postMessage(
    {
      type: "setFiles",
      files: fileContents,
    },
    "*"
  );
}

async function requestFileContentsFromWindow() {
  const shinylivePanel = document.getElementById("shinylive-panel");
  if (shinylivePanel === null) {
    return [];
  }

  const reply = await postMessageAndWaitForReply(
    document.getElementById("shinylive-panel").contentWindow,
    { type: "getFiles" }
  );

  return reply;
}

function postMessageAndWaitForReply(targetWindow, message) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();

    channel.port1.onmessage = (event) => {
      resolve(event.data);
    };

    targetWindow.postMessage(message, "*", [channel.port2]);
  });
}

// =====================================================================================
// Code for saving/loading language switch state to localStorage
// =====================================================================================

const LANGUAGE_INPUT_ID = "language_switch";
const VERBOSITY_INPUT_ID = "verbosity";

$(document).on("shiny:sessioninitialized", function () {
  // Checkbox state is stored as a string in localstorage
  const languageSavedState = localStorage.getItem(LANGUAGE_INPUT_ID) === "true";
  if (languageSavedState !== null) {
    setInputValue(LANGUAGE_INPUT_ID, languageSavedState);
  }

  const verbositySavedState = localStorage.getItem(VERBOSITY_INPUT_ID);
  if (verbositySavedState !== null) {
    setInputValue(VERBOSITY_INPUT_ID, verbositySavedState);
  }
});

$(document).on("shiny:inputchanged", function (e) {
  if ([LANGUAGE_INPUT_ID, VERBOSITY_INPUT_ID].includes(e.name)) {
    localStorage.setItem(e.name, e.value);
  }
});

function setInputValue(inputId, value) {
  const el = document.getElementById(inputId);
  if (!el) {
    console.error("Element with id '" + inputId + "' not found");
    return;
  }
  const binding = $(el).data("shiny-input-binding");
  binding.setValue(el, value);
  $(el).trigger("change");
}

// =====================================================================================
// Recovery code
// =====================================================================================

// Client mirror of server side chat history state
let chat_history = [];

// Server sends this on new user input or assistant response
Shiny.addCustomMessageHandler("sync-chat-messages", (msg) => {
  chat_history.push(...msg.messages);
});

$(document).on("shiny:disconnected", async () => {
  // On disconnect, we save all the state needed for restoration to the URL hash
  // and update the URL immediately. This way, the user can either hit Reload,
  // or click the Reconnect button, and either way they'll get back to the same
  // state.
  //
  // The restore state starts out as two pieces of JSON that look like:
  //
  // chat_history =
  //   [
  //     { "role": "user", "content": "Hello" },
  //     { "role": "assistant", "content": "Certainly! I can help you with that." }
  //   ];
  //
  // files =
  //   [
  //     { "name": "app.py", "content": "print('Hello, world!')" }
  //   ]
  // }
  //
  // Each value is JSONified, base64 encoded, and then turned into query string
  // pairs. The final URL looks like:
  // #chat_history=<base64>&files=<base64>

  // We can save the chat history immediately, since we already have the data.
  // Go ahead and do that, in case something goes wrong with the (much more
  // complicated) process to get the file data.
  let hash =
    "#chat_history=" +
    encodeURIComponent(encodeToBase64(JSON.stringify(chat_history)));
  window.location.hash = hash;

  try {
    // If we successfully get the code from the shinylive panel, we'll add that
    // to the hash as well.
    const fileContents = await requestFileContentsFromWindow();
    hash +=
      "&files=" +
      encodeURIComponent(encodeToBase64(JSON.stringify(fileContents.files)));
    window.location.hash = hash;
  } catch (e) {
    console.error("Failed to get file contents from shinylive panel", e);
  }

  // Now that we're done updating the hash, we can show the reconnect modal to
  // encourage the user to reconnect.
  const template = document.querySelector("template#custom_reconnect_modal");
  const clone = document.importNode(template.content, true);
  document.body.appendChild(clone);
});

$(document).on("click", "#custom-reconnect-link", () => {
  window.location.reload();
});

const shinyliveReadyPromise = new Promise((resolve) => {
  window.addEventListener("message", (event) => {
    if (event.data.type === "shinyliveReady") {
      resolve();
    }
  });
});

// Now restore shinylive file contents from window.location.hash, if any. (We
// don't need to worry about restoring the chat history here; that's being
// handled by the server, which always has access to the initial value of
// window.location.hash.)
async function restoreFileContents() {
  // Drop "#" from hash
  let hash = window.location.hash?.replace(/^#/, "");
  if (!hash) {
    return;
  }
  const params = new URLSearchParams(hash);
  if (!params.has("files")) {
    return;
  }
  // Wait for shinylive to come online
  await shinyliveReadyPromise;
  const files = JSON.parse(
    decodeFromBase64(decodeURIComponent(params.get("files")))
  );
  if (files.length > 0) {
    console.log(`Restoring ${files.length} file(s)`);
  }
  sendFileContentsToWindow(files);
  window.location.hash = "";
}
restoreFileContents().catch((err) => {
  console.error("Failed to restore", err);
});

// =====================================================================================
// Unicode-aware base64 encoding/decoding
// =====================================================================================

function encodeToBase64(str) {
  const encoder = new TextEncoder();
  const uint8Array = encoder.encode(str);
  return btoa(String.fromCharCode.apply(null, uint8Array));
}

function decodeFromBase64(base64) {
  const binaryString = atob(base64);
  const uint8Array = Uint8Array.from(binaryString, (char) =>
    char.charCodeAt(0)
  );
  const decoder = new TextDecoder();
  return decoder.decode(uint8Array);
}

// =====================================================================================
// Quick and dirty sidebar drag resize
// =====================================================================================

document.addEventListener("DOMContentLoaded", () => {
  const MIN_WIDTH = "10vw";
  const MAX_WIDTH = "90vw";
  const resizer = document.querySelector(".sidebar-resizer");

  function updateLayout(leftWidth) {
    document
      .querySelector(".bslib-sidebar-layout")
      .style.setProperty(
        "--_sidebar-width",
        `max(min(${leftWidth}px, ${MAX_WIDTH}), ${MIN_WIDTH})`
      );
  }

  const handlePointerMove = (e) => {
    const leftWidth = e.clientX;
    updateLayout(leftWidth);
  };

  const handlePointerUp = (e) => {
    resizer.releasePointerCapture(e.pointerId);
    document.removeEventListener("pointermove", handlePointerMove);
    document.removeEventListener("pointerup", handlePointerUp);
  };

  const handlePointerDown = (e) => {
    resizer.setPointerCapture(e.pointerId);
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
  };

  resizer.addEventListener("pointerdown", handlePointerDown);
});

function showShinylivePanel(smooth) {
  document.querySelector(".bslib-page-sidebar").classList.remove("main-hidden");

  const el = document.querySelector(".bslib-sidebar-layout");
  if (smooth) {
    el.classList.add("sidebar-smooth-transition");
    setTimeout(() => {
      el.classList.remove("sidebar-smooth-transition");
    }, 500);
  }

  document
    .querySelector(".bslib-sidebar-layout")
    .style.setProperty("--_sidebar-width", "400px");
}
