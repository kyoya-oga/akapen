export const OVERLAY_CSS = `
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans CJK JP", sans-serif;
  font-size: 13px;
  color: #0f172a;
}
* {
  box-sizing: border-box;
}
.pcr-hover-box {
  position: fixed;
  border: 2px solid #2563eb;
  background: rgba(37, 99, 235, 0.08);
  pointer-events: none;
  border-radius: 3px;
  z-index: 2147483640;
}
.pcr-drag-box {
  position: fixed;
  border: 2px dashed #ea580c;
  background: rgba(234, 88, 12, 0.12);
  pointer-events: none;
  border-radius: 3px;
  z-index: 2147483641;
}
.pcr-anchor-box {
  position: fixed;
  border: 2px solid #dc2626;
  pointer-events: none;
  border-radius: 3px;
  z-index: 2147483642;
}
.pcr-anchor-box.is-fallback {
  border-style: dashed;
}
.pcr-badge {
  position: fixed;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 9999px;
  background: #dc2626;
  color: #ffffff;
  font-weight: 700;
  font-size: 12px;
  line-height: 22px;
  text-align: center;
  cursor: pointer;
  pointer-events: auto;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
  border: 1.5px solid #ffffff;
  z-index: 2147483643;
  user-select: none;
}
.pcr-badge:hover {
  transform: scale(1.08);
  background: #b91c1c;
}
.pcr-bar {
  position: fixed;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: #0f172a;
  color: #f8fafc;
  padding: 8px 12px;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  pointer-events: auto;
  z-index: 2147483646;
  user-select: none;
  max-width: 92vw;
}
.pcr-bar-main {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.pcr-drag-handle {
  cursor: grab;
  padding: 2px 6px;
  font-weight: 700;
  color: #94a3b8;
  font-size: 12px;
}
.pcr-btn {
  appearance: none;
  border: 1px solid #334155;
  background: #1e293b;
  color: #f8fafc;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  line-height: 1.3;
}
.pcr-btn:hover {
  background: #334155;
}
.pcr-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.pcr-btn.is-active {
  background: #ca8a04;
  border-color: #eab308;
  color: #ffffff;
}
.pcr-btn-primary {
  background: #2563eb;
  border-color: #3b82f6;
  color: #ffffff;
}
.pcr-btn-primary:hover {
  background: #1d4ed8;
}
.pcr-btn-danger {
  background: #991b1b;
  border-color: #dc2626;
  color: #ffffff;
}
.pcr-btn-danger:hover {
  background: #7f1d1d;
}
.pcr-warnings {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 11px;
  color: #fde047;
}
.pcr-status {
  font-size: 11px;
  color: #86efac;
}
.pcr-hint {
  font-size: 11px;
  color: #cbd5e1;
}
.pcr-quicklist-footer {
  display: flex;
  justify-content: flex-end;
  border-top: 1px solid #334155;
  padding-top: 4px;
}
.pcr-btn-danger-text {
  background: transparent;
  border-color: transparent;
  color: #fca5a5;
  font-size: 11px;
}
.pcr-quicklist {
  margin-top: 4px;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 6px;
  max-height: 220px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pcr-quicklist-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  background: #0f172a;
  cursor: pointer;
  font-size: 12px;
}
.pcr-quicklist-item:hover {
  background: #334155;
}
.pcr-popover {
  position: fixed;
  width: 340px;
  max-width: 94vw;
  background: #ffffff;
  color: #0f172a;
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.28);
  padding: 12px;
  pointer-events: auto;
  z-index: 2147483645;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pcr-popover-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 700;
  font-size: 12px;
  color: #334155;
}
.pcr-field-label {
  font-size: 11px;
  font-weight: 600;
  color: #475569;
  margin-bottom: 2px;
  display: block;
}
.pcr-textarea, .pcr-input {
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
  font-family: inherit;
  color: #0f172a;
  background: #ffffff;
}
.pcr-textarea:focus, .pcr-input:focus {
  outline: 2px solid #2563eb;
  border-color: transparent;
}
.pcr-dropzone {
  border: 2px dashed #94a3b8;
  border-radius: 8px;
  padding: 12px;
  text-align: center;
  background: #f8fafc;
  color: #475569;
  cursor: pointer;
  font-size: 12px;
}
.pcr-dropzone:hover {
  border-color: #2563eb;
  background: #eff6ff;
}
.pcr-dropzone img {
  max-width: 100%;
  max-height: 120px;
  margin-top: 6px;
  border-radius: 4px;
}
.pcr-popover-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin-top: 4px;
}
.pcr-note {
  font-size: 11px;
  color: #b45309;
  background: #fef3c7;
  padding: 4px 6px;
  border-radius: 4px;
}
`;
