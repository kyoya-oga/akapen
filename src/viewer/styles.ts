export const VIEWER_CSS = `
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", "Noto Sans CJK JP", sans-serif;
  color: #0f172a;
  background: #f1f5f9;
  height: 100vh;
  display: flex;
  flex-direction: column;
}
#app {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}
.v-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  background: #0f172a;
  color: #f8fafc;
  gap: 12px;
  flex-wrap: wrap;
}
.v-title-area {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.v-title {
  font-size: 15px;
  font-weight: 700;
}
.v-meta {
  font-size: 12px;
  color: #94a3b8;
}
.v-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.v-seg-group {
  display: inline-flex;
  background: #1e293b;
  padding: 2px;
  border-radius: 6px;
  border: 1px solid #334155;
}
.v-seg-btn {
  appearance: none;
  border: none;
  background: transparent;
  color: #cbd5e1;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 600;
  border-radius: 4px;
  cursor: pointer;
}
.v-seg-btn.is-active {
  background: #2563eb;
  color: #ffffff;
}
.v-btn {
  appearance: none;
  border: 1px solid #334155;
  background: #1e293b;
  color: #f8fafc;
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.v-btn:hover {
  background: #334155;
}
.v-btn-light {
  border-color: #cbd5e1;
  background: #ffffff;
  color: #0f172a;
}
.v-btn-light:hover {
  background: #f8fafc;
}
.v-main {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.v-preview-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  background: #e2e8f0;
  overflow: auto;
  padding: 16px;
  align-items: center;
}
.v-iframe-wrap {
  background: #ffffff;
  box-shadow: 0 10px 25px rgba(15, 23, 42, 0.15);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  height: 100%;
  max-width: 100%;
}
.v-iframe {
  border: none;
  width: 100%;
  flex: 1;
  background: #ffffff;
}
.v-sidebar {
  width: 420px;
  max-width: 45vw;
  background: #ffffff;
  border-left: 1px solid #cbd5e1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.v-notice {
  font-size: 11px;
  color: #475569;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  padding: 8px 10px;
  border-radius: 6px;
}
.v-card {
  border: 1px solid #cbd5e1;
  border-radius: 8px;
  padding: 12px;
  background: #ffffff;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.v-card.is-selected {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}
.v-card-url {
  font-size: 11px;
  color: #64748b;
  margin: 2px 0 6px;
  word-break: break-all;
}
.v-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.v-badge {
  display: inline-block;
  min-width: 22px;
  height: 22px;
  line-height: 22px;
  text-align: center;
  border-radius: 9999px;
  background: #dc2626;
  color: #ffffff;
  font-weight: 700;
  font-size: 12px;
  padding: 0 6px;
}
.v-type-tag {
  font-size: 12px;
  font-weight: 700;
  color: #1e293b;
}
.v-diff-box {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 8px;
  font-size: 13px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.v-diff-del {
  background: #fee2e2;
  color: #991b1b;
  text-decoration: line-through;
}
.v-diff-ins {
  background: #dcfce7;
  color: #166534;
  font-weight: 600;
}
.v-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.v-table th, .v-table td {
  border: 1px solid #cbd5e1;
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
}
.v-table th {
  background: #f1f5f9;
  font-weight: 600;
}
.v-att-img {
  max-width: 100%;
  max-height: 160px;
  border-radius: 6px;
  border: 1px solid #cbd5e1;
}
`;
