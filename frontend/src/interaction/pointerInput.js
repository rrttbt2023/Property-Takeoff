export const INPUT_SESSION = Object.freeze({
  IDLE: "idle",
  STYLUS_DRAW: "stylus-draw",
  FINGER_PAN: "finger-pan",
  PINCH_ZOOM: "pinch-zoom",
  MOUSE_DRAW: "mouse-draw",
});

export function getPointerKindFromRawEvent(original) {
  if (!original) return "unknown";
  if (typeof original.pointerType === "string" && original.pointerType) {
    return original.pointerType.toLowerCase();
  }
  const touch =
    original.touches?.[0] ||
    original.changedTouches?.[0] ||
    original.targetTouches?.[0] ||
    null;
  const touchType = String(touch?.touchType || "").toLowerCase();
  if (touchType === "stylus") return "pen";
  if (touch) return "touch";
  const type = String(original.type || "").toLowerCase();
  if (type.startsWith("touch")) return "touch";
  if (type.startsWith("mouse")) return "mouse";
  return "unknown";
}

export function isLikelyStylusRawEvent(
  original,
  pointerKind = getPointerKindFromRawEvent(original)
) {
  if (!original) return false;
  if (pointerKind === "pen" || pointerKind === "mouse") return true;
  const touch =
    original.touches?.[0] ||
    original.changedTouches?.[0] ||
    original.targetTouches?.[0] ||
    null;
  const touchType = String(touch?.touchType || "").toLowerCase();
  if (touchType === "stylus") return true;
  if (
    Number.isFinite(Number(original.altitudeAngle)) ||
    Number.isFinite(Number(original.azimuthAngle)) ||
    Number.isFinite(Number(original.tiltX)) ||
    Number.isFinite(Number(original.tiltY)) ||
    Number.isFinite(Number(original.twist))
  ) {
    return true;
  }
  const width = Number(original.width ?? touch?.radiusX ?? touch?.webkitRadiusX);
  const height = Number(original.height ?? touch?.radiusY ?? touch?.webkitRadiusY);
  const pressure = Number(original.pressure ?? touch?.force ?? original.webkitForce);
  return (
    pointerKind === "touch" &&
    Number.isFinite(pressure) &&
    pressure > 0 &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width <= 5 &&
    height <= 5
  );
}

export function isConfirmedStylusRawEvent(
  original,
  pointerKind = getPointerKindFromRawEvent(original)
) {
  if (!original) return false;
  if (pointerKind === "pen") return true;
  const touch =
    original.touches?.[0] ||
    original.changedTouches?.[0] ||
    original.targetTouches?.[0] ||
    null;
  const touchType = String(touch?.touchType || "").toLowerCase();
  if (touchType === "stylus") return true;
  return (
    Number.isFinite(Number(original.altitudeAngle)) ||
    Number.isFinite(Number(original.azimuthAngle)) ||
    Number.isFinite(Number(original.tiltX)) ||
    Number.isFinite(Number(original.tiltY)) ||
    Number.isFinite(Number(original.twist))
  );
}

export function extractClientPointFromRawInputEvent(original) {
  if (!original) return null;
  const directX = Number(original.clientX);
  const directY = Number(original.clientY);
  if (Number.isFinite(directX) && Number.isFinite(directY)) {
    return { clientX: directX, clientY: directY };
  }
  const touch =
    original.touches?.[0] ||
    original.changedTouches?.[0] ||
    original.targetTouches?.[0] ||
    null;
  const touchX = Number(touch?.clientX);
  const touchY = Number(touch?.clientY);
  if (Number.isFinite(touchX) && Number.isFinite(touchY)) {
    return { clientX: touchX, clientY: touchY };
  }
  return null;
}

export function getRawTouchCount(original) {
  if (!original) return 0;
  const touchesCount = Number(original.touches?.length);
  if (Number.isFinite(touchesCount) && touchesCount > 0) return touchesCount;
  const targetTouchesCount = Number(original.targetTouches?.length);
  if (Number.isFinite(targetTouchesCount) && targetTouchesCount > 0) return targetTouchesCount;
  const changedTouchesCount = Number(original.changedTouches?.length);
  if (Number.isFinite(changedTouchesCount) && changedTouchesCount > 0) return changedTouchesCount;
  return 0;
}

export function createPointerInputMachine({ stylusOnly = false } = {}) {
  const pointers = new Map();
  let session = INPUT_SESSION.IDLE;

  const resolve = () => {
    const values = [...pointers.values()];
    const touchCount = values.filter((item) => item.kind === "touch").length;
    const hasStylus = values.some((item) => item.stylus);
    const hasMouse = values.some((item) => item.kind === "mouse");
    if (touchCount >= 2) return INPUT_SESSION.PINCH_ZOOM;
    if (hasStylus) return INPUT_SESSION.STYLUS_DRAW;
    if (touchCount === 1) return stylusOnly ? INPUT_SESSION.FINGER_PAN : INPUT_SESSION.STYLUS_DRAW;
    if (hasMouse) return INPUT_SESSION.MOUSE_DRAW;
    return INPUT_SESSION.IDLE;
  };

  return {
    begin(pointerId, original) {
      const kind = getPointerKindFromRawEvent(original);
      pointers.set(pointerId, {
        kind,
        stylus: isConfirmedStylusRawEvent(original, kind),
      });
      session = resolve();
      return session;
    },
    update(pointerId, original) {
      if (pointers.has(pointerId)) {
        const kind = getPointerKindFromRawEvent(original);
        pointers.set(pointerId, {
          kind,
          stylus: isConfirmedStylusRawEvent(original, kind),
        });
      }
      session = resolve();
      return session;
    },
    end(pointerId) {
      pointers.delete(pointerId);
      session = resolve();
      return session;
    },
    cancel() {
      pointers.clear();
      session = INPUT_SESSION.IDLE;
      return session;
    },
    getSession() {
      return session;
    },
    shouldDraw() {
      return session === INPUT_SESSION.STYLUS_DRAW || session === INPUT_SESSION.MOUSE_DRAW;
    },
    shouldNavigate() {
      return session === INPUT_SESSION.FINGER_PAN || session === INPUT_SESSION.PINCH_ZOOM;
    },
  };
}
