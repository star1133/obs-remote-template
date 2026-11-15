// OBS Remote settings: a small native window (no browser) for everything the old setup page did: status, the phone
// QR code, devices, connection mode. It talks to the agent on 127.0.0.1 (setup-server.js: plain-text
// status at /api/status.txt, a token from /api/token, the same POST actions as the page) and draws itself with GDI.
//   obs-remote-settings.exe [--port=47890]
// Build: gcc -O2 -s -municode -mwindows -o obs-remote-settings.exe settings.c settings.res -lwinhttp -ldwmapi -lshell32
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <windowsx.h>
#include <winhttp.h>
#include <dwmapi.h>
#include <shellapi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define APP_CLASS L"OBSRemoteSettings"
#define WM_APP_STATUS (WM_APP + 1)
#define WM_APP_DONE (WM_APP + 2)
#define MAX_DEV 32
#define QR_MAX 177

// Colours of the old setup page (setup.css), so it still looks like OBS Remote next to OBS.
#define C_BG RGB(0x17, 0x17, 0x1a)
#define C_LINE RGB(0x2c, 0x2c, 0x31)
#define C_FIELD RGB(0x10, 0x10, 0x13)
#define C_TEXT RGB(0xeb, 0xea, 0xe6)
#define C_DIM RGB(0x8f, 0x8e, 0x8a)
#define C_ACC RGB(0xe8, 0xe6, 0xe0)
#define C_RED RGB(0xe5, 0x48, 0x3a)
#define C_OK RGB(0x46, 0xc4, 0x6b)
#define C_WARN RGB(0xe0, 0xa5, 0x26)
#define C_BAD RGB(0xf0, 0x58, 0x4b)
#define C_BTN RGB(0x23, 0x23, 0x28)
#define C_BTN_HI RGB(0x2b, 0x2b, 0x31)
#define C_BTN_LINE RGB(0x36, 0x36, 0x3c)

typedef struct { wchar_t cid[64], name[96], role[16]; int online; double created; } Dev;
typedef struct {
  int ok; // the agent answered
  wchar_t host[64], obs[24], obsDetail[96], relay[24], relayDetail[160], url[256], mode[12], cloudHost[96], room[32];
  int obsws, canSwitch, hosted, presentKeys;
  double started;
  int hasTunnel;
  wchar_t tun[24], tunUrl[200], tunDetail[160];
  Dev dev[MAX_DEV];
  int ndev;
} Status;

typedef struct { int active; wchar_t code[32], room[32], url[300]; double exp; int n; unsigned char m[QR_MAX * QR_MAX]; } Pair;

enum { H_NONE, H_ROLE, H_CODE, H_COPY, H_PAGE, H_MODE, H_REVOKE, H_SLIDES, H_QUIT, H_UNINSTALL, H_PWSAVE };
// Which request a finished action thread answers (WM_APP_DONE wParam).
enum { A_PAIR = 1, A_SIMPLE };

typedef struct { RECT r; int id, arg; } Hit;

static HINSTANCE inst;
static HWND wnd, pwEdit;
static unsigned short port = 47890;
static int dpi = 96;
static HFONT fTitle, fH2, fBody, fBold, fSmall, fCode, fMono;
static Status st; // the UI's copy, replaced on WM_APP_STATUS
static Pair pair;
static int role; // 0 full, 1 control, 2 view only
static wchar_t pairErr[200], pairMsg[200], modeMsg[200];
static int baseN = -1, baseOnline, uninstallSure;
static double lastStarted;
static Hit hits[96];
static int nhits, hoverId, hoverArg, scrollY, contentH;
static RECT pwRect;
static char token[80];
static CRITICAL_SECTION tokenLock;

static int S(int v) { return MulDiv(v, dpi, 96); }

// ---------------------------------------------------------------- HTTP to the agent (127.0.0.1 only)

/** Returns a malloc'd UTF-8 body (NUL-terminated) or NULL; *code gets the HTTP status. */
static char *http(const wchar_t *method, const wchar_t *path, const char *body, int *code) {
  char *out = NULL;
  *code = 0;
  HINTERNET s = WinHttpOpen(L"OBS Remote settings", WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
  if (!s) return NULL;
  WinHttpSetTimeouts(s, 1500, 1500, 3000, 8000);
  HINTERNET c = WinHttpConnect(s, L"127.0.0.1", port, 0);
  HINTERNET r = c ? WinHttpOpenRequest(c, method, path, NULL, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0) : NULL;
  if (r) {
    wchar_t hdr[200];
    EnterCriticalSection(&tokenLock);
    swprintf(hdr, 200, L"content-type: application/json\r\nx-obsr-csrf: %hs\r\n", token);
    LeaveCriticalSection(&tokenLock);
    DWORD len = body ? (DWORD)strlen(body) : 0;
    if (WinHttpSendRequest(r, hdr, (DWORD)-1, (void *)body, len, len, 0) && WinHttpReceiveResponse(r, NULL)) {
      DWORD sc = 0, sz = sizeof sc;
      WinHttpQueryHeaders(r, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER, NULL, &sc, &sz, NULL);
      *code = (int)sc;
      size_t cap = 4096, n = 0;
      out = malloc(cap);
      DWORD got;
      while (out && WinHttpQueryDataAvailable(r, &got) && got) {
        if (n + got + 1 > cap) { cap = (n + got + 1) * 2; char *t = realloc(out, cap); if (!t) { free(out); out = NULL; break; } out = t; }
        DWORD rd = 0;
        if (!WinHttpReadData(r, out + n, got, &rd) || !rd) break;
        n += rd;
      }
      if (out) out[n] = 0;
    }
    WinHttpCloseHandle(r);
  }
  if (c) WinHttpCloseHandle(c);
  WinHttpCloseHandle(s);
  return out;
}

static void refreshToken(void) {
  int code;
  char *t = http(L"GET", L"/api/token", NULL, &code);
  if (t && code == 200) {
    EnterCriticalSection(&tokenLock);
    snprintf(token, sizeof token, "%s", t);
    LeaveCriticalSection(&tokenLock);
  }
  free(t);
}

/** POST with the token; fetches a fresh one once when the agent restarted (403). */
static char *post(const wchar_t *path, const char *body, int *code) {
  char *r = http(L"POST", path, body ? body : "{}", code);
  if (*code == 403) { free(r); refreshToken(); r = http(L"POST", path, body ? body : "{}", code); }
  return r;
}

static void utf8w(const char *in, wchar_t *out, int cap) {
  if (!MultiByteToWideChar(CP_UTF8, 0, in, -1, out, cap)) out[0] = 0;
  out[cap - 1] = 0;
}

/** The message of a failed action: the agent answers {"error":"..."}. */
static void errorOf(const char *body, wchar_t *out, int cap) {
  const char *e = body ? strstr(body, "\"error\":\"") : NULL;
  if (!e) { wcsncpy(out, L"OBS Remote did not answer. Is OBS open?", cap); return; }
  e += 9;
  char buf[400];
  int i = 0;
  for (; *e && *e != '"' && i < (int)sizeof buf - 1; e++) buf[i++] = *e == '\\' && e[1] ? *++e : *e;
  buf[i] = 0;
  utf8w(buf, out, cap);
}

// ---------------------------------------------------------------- status text (one "key=value" per line, tabs inside)

/** Splits a tab-separated value in place; returns how many parts. */
static int fields(wchar_t *v, wchar_t **part, int max) {
  int n = 0;
  part[n++] = v;
  for (wchar_t *p = v; *p && n < max; p++) if (*p == L'\t') { *p = 0; part[n++] = p + 1; }
  for (int i = n; i < max; i++) part[i] = L"";
  return n;
}

#define CPY(dst, src) (wcsncpy((dst), (src), sizeof(dst) / sizeof(wchar_t) - 1), (dst)[sizeof(dst) / sizeof(wchar_t) - 1] = 0)

static void parseStatus(const char *txt, Status *s) {
  memset(s, 0, sizeof *s);
  int len = MultiByteToWideChar(CP_UTF8, 0, txt, -1, NULL, 0);
  wchar_t *w = malloc(sizeof(wchar_t) * (len + 1));
  if (!w) return;
  MultiByteToWideChar(CP_UTF8, 0, txt, -1, w, len);
  s->ok = 1;
  for (wchar_t *line = w, *next; line && *line; line = next) {
    next = wcschr(line, L'\n');
    if (next) *next++ = 0;
    wchar_t *eq = wcschr(line, L'=');
    if (!eq) continue;
    *eq = 0;
    wchar_t *k = line, *v = eq + 1, *p[6];
    if (!wcscmp(k, L"host")) CPY(s->host, v);
    else if (!wcscmp(k, L"obs")) { fields(v, p, 2); CPY(s->obs, p[0]); CPY(s->obsDetail, p[1]); }
    else if (!wcscmp(k, L"obsws")) s->obsws = _wtoi(v);
    else if (!wcscmp(k, L"relay")) { fields(v, p, 2); CPY(s->relay, p[0]); CPY(s->relayDetail, p[1]); }
    else if (!wcscmp(k, L"url")) CPY(s->url, v);
    else if (!wcscmp(k, L"mode")) CPY(s->mode, v);
    else if (!wcscmp(k, L"canSwitch")) s->canSwitch = _wtoi(v);
    else if (!wcscmp(k, L"cloudHost")) CPY(s->cloudHost, v);
    else if (!wcscmp(k, L"hosted")) s->hosted = _wtoi(v);
    else if (!wcscmp(k, L"presentKeys")) s->presentKeys = _wtoi(v);
    else if (!wcscmp(k, L"started")) s->started = _wtof(v);
    else if (!wcscmp(k, L"room")) CPY(s->room, v);
    else if (!wcscmp(k, L"tunnel")) { fields(v, p, 3); s->hasTunnel = 1; CPY(s->tun, p[0]); CPY(s->tunUrl, p[1]); CPY(s->tunDetail, p[2]); }
    else if (!wcscmp(k, L"dev") && s->ndev < MAX_DEV) {
      fields(v, p, 5);
      Dev *d = &s->dev[s->ndev++];
      CPY(d->cid, p[0]); d->online = _wtoi(p[1]); CPY(d->role, p[2]); d->created = _wtof(p[3]); CPY(d->name, p[4]);
    }
  }
  free(w);
}

/** Polls the agent: every 1.5 s while the window is on screen, every 5 s when minimised. */
static DWORD WINAPI poller(void *arg) {
  (void)arg;
  double started = -1;
  for (;;) {
    int code;
    char *txt = http(L"GET", L"/api/status.txt", NULL, &code);
    Status *s = calloc(1, sizeof *s);
    if (s && txt && code == 200) {
      parseStatus(txt, s);
      if (s->started != started || !token[0]) { refreshToken(); started = s->started; }
    }
    free(txt);
    if (s && !PostMessageW(wnd, WM_APP_STATUS, 0, (LPARAM)s)) free(s);
    Sleep(IsIconic(wnd) ? 5000 : 1500);
  }
  return 0;
}

// ---------------------------------------------------------------- actions (each in its own short thread)

typedef struct { int kind; wchar_t path[64]; char body[600]; } Job;
typedef struct { int kind, code; char *body; } Done;

static DWORD WINAPI jobThread(void *arg) {
  Job *j = arg;
  if (!token[0]) refreshToken();
  Done *d = calloc(1, sizeof *d);
  if (d) {
    d->kind = j->kind;
    d->body = post(j->path, j->body, &d->code);
    if (!PostMessageW(wnd, WM_APP_DONE, 0, (LPARAM)d)) { free(d->body); free(d); }
  }
  free(j);
  return 0;
}

static void run(int kind, const wchar_t *path, const char *body) {
  Job *j = calloc(1, sizeof *j);
  if (!j) return;
  j->kind = kind;
  wcsncpy(j->path, path, 63);
  if (body) snprintf(j->body, sizeof j->body, "%s", body);
  HANDLE h = CreateThread(NULL, 0, jobThread, j, 0, NULL);
  if (h) CloseHandle(h); else free(j);
}

static void parsePair(const char *txt) {
  memset(&pair, 0, sizeof pair);
  wchar_t w[QR_MAX + 400];
  int row = -1;
  for (const char *line = txt; line && *line;) {
    const char *nl = strchr(line, '\n');
    int n = nl ? (int)(nl - line) : (int)strlen(line);
    char buf[QR_MAX + 400];
    if (n >= (int)sizeof buf) n = sizeof buf - 1;
    memcpy(buf, line, n);
    buf[n] = 0;
    if (row >= 0 && row < pair.n) {
      for (int x = 0; x < pair.n && buf[x]; x++) pair.m[row * pair.n + x] = buf[x] == '1';
      row++;
    } else if (!strncmp(buf, "code=", 5)) { utf8w(buf + 5, w, 64); CPY(pair.code, w); }
    else if (!strncmp(buf, "room=", 5)) { utf8w(buf + 5, w, 64); CPY(pair.room, w); }
    else if (!strncmp(buf, "url=", 4)) { utf8w(buf + 4, w, 300); CPY(pair.url, w); }
    else if (!strncmp(buf, "exp=", 4)) pair.exp = atof(buf + 4);
    else if (!strncmp(buf, "qr=", 3)) { pair.n = atoi(buf + 3); if (pair.n < 0 || pair.n > QR_MAX) pair.n = 0; row = 0; }
    line = nl ? nl + 1 : NULL;
  }
  pair.active = pair.n > 0 && pair.code[0];
}

static double nowMs(void) {
  FILETIME ft;
  GetSystemTimeAsFileTime(&ft);
  ULARGE_INTEGER u = { .LowPart = ft.dwLowDateTime, .HighPart = ft.dwHighDateTime };
  return (double)(u.QuadPart / 10000ULL) - 11644473600000.0;
}

static int onlineCount(void) { int n = 0; for (int i = 0; i < st.ndev; i++) n += st.dev[i].online; return n; }

static void copyText(const wchar_t *t) {
  if (!OpenClipboard(wnd)) return;
  EmptyClipboard();
  size_t n = (wcslen(t) + 1) * sizeof(wchar_t);
  HGLOBAL g = GlobalAlloc(GMEM_MOVEABLE, n);
  if (g) { memcpy(GlobalLock(g), t, n); GlobalUnlock(g); SetClipboardData(CF_UNICODETEXT, g); }
  CloseClipboard();
}

/** JSON string body for the password, escaped. */
static void jsonPassword(const wchar_t *pw, char *out, int cap) {
  char u[400];
  WideCharToMultiByte(CP_UTF8, 0, pw, -1, u, sizeof u, NULL, NULL);
  int o = snprintf(out, cap, "{\"password\":\"");
  for (char *p = u; *p && o < cap - 8; p++) {
    unsigned char ch = (unsigned char)*p;
    if (ch == '"' || ch == '\\') { out[o++] = '\\'; out[o++] = (char)ch; }
    else if (ch < 0x20) o += snprintf(out + o, cap - o, "\\u%04x", ch);
    else out[o++] = (char)ch;
  }
  snprintf(out + o, cap - o, "\"}");
}

// ---------------------------------------------------------------- drawing helpers

static void makeFonts(void) {
  HFONT *all[] = { &fTitle, &fH2, &fBody, &fBold, &fSmall, &fCode, &fMono };
  for (unsigned i = 0; i < sizeof all / sizeof *all; i++) if (*all[i]) DeleteObject(*all[i]);
  #define FONT(px, w, face) CreateFontW(-S(px), 0, 0, 0, w, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, face)
  fTitle = FONT(19, FW_SEMIBOLD, L"Segoe UI");
  fH2 = FONT(11, FW_SEMIBOLD, L"Segoe UI");
  fBody = FONT(14, FW_NORMAL, L"Segoe UI");
  fBold = FONT(14, FW_SEMIBOLD, L"Segoe UI");
  fSmall = FONT(12, FW_NORMAL, L"Segoe UI");
  fCode = FONT(21, FW_SEMIBOLD, L"Cascadia Mono");
  fMono = FONT(11, FW_NORMAL, L"Cascadia Mono");
  #undef FONT
  if (pwEdit) SendMessageW(pwEdit, WM_SETFONT, (WPARAM)fBody, TRUE);
}

static void fillRect(HDC dc, RECT r, COLORREF c) { HBRUSH b = CreateSolidBrush(c); FillRect(dc, &r, b); DeleteObject(b); }

static void roundRect(HDC dc, RECT r, int rad, COLORREF fill, COLORREF line) {
  HBRUSH b = CreateSolidBrush(fill);
  HPEN p = CreatePen(PS_SOLID, 1, line);
  HGDIOBJ ob = SelectObject(dc, b), op = SelectObject(dc, p);
  RoundRect(dc, r.left, r.top, r.right, r.bottom, rad, rad);
  SelectObject(dc, ob); SelectObject(dc, op);
  DeleteObject(b); DeleteObject(p);
}

static void dot(HDC dc, int x, int cy, COLORREF c) {
  int d = S(8);
  RECT r = { x, cy - d / 2, x + d, cy - d / 2 + d };
  roundRect(dc, r, d, c, c);
}

static int textH(HDC dc, const wchar_t *s, int w, HFONT f) {
  RECT r = { 0, 0, w, 0 };
  SelectObject(dc, f);
  DrawTextW(dc, s, -1, &r, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
  return r.bottom;
}

static void text(HDC dc, const wchar_t *s, RECT r, HFONT f, COLORREF c, UINT fmt) {
  SelectObject(dc, f);
  SetTextColor(dc, c);
  SetBkMode(dc, TRANSPARENT);
  DrawTextW(dc, s, -1, &r, fmt | DT_NOPREFIX);
}

static int textW(HDC dc, const wchar_t *s, HFONT f) {
  SIZE z;
  SelectObject(dc, f);
  GetTextExtentPoint32W(dc, s, (int)wcslen(s), &z);
  return z.cx;
}

static void addHit(RECT r, int id, int arg) { if (nhits < 96) hits[nhits++] = (Hit){ r, id, arg }; }

enum { B_NORMAL, B_PRIMARY, B_QUIET, B_DANGER, B_ON };

/** A button at (x, y), as wide as its label (or w when given). Returns its right edge. */
static int button(HDC dc, int x, int y, int w, const wchar_t *label, int kind, int id, int arg) {
  HFONT f = kind == B_PRIMARY ? fBold : fBody;
  if (!w) w = textW(dc, label, f) + S(kind == B_QUIET || kind == B_DANGER ? 14 : 28);
  RECT r = { x, y, x + w, y + S(34) };
  int hot = hoverId == id && hoverArg == arg;
  COLORREF fill = C_BTN, line = C_BTN_LINE, fg = C_TEXT;
  if (kind == B_PRIMARY) { fill = hot ? RGB(255, 255, 255) : C_ACC; line = fill; fg = RGB(0x14, 0x14, 0x16); }
  else if (kind == B_QUIET || kind == B_DANGER) { fill = hot ? C_BTN : C_BG; line = fill; fg = kind == B_DANGER ? RGB(0xf0, 0x8a, 0x80) : hot ? C_TEXT : C_DIM; }
  else if (kind == B_ON) { fill = C_BTN_HI; line = C_ACC; }
  else if (hot) fill = C_BTN_HI;
  roundRect(dc, r, S(10), fill, line);
  text(dc, label, r, f, fg, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
  addHit(r, id, arg);
  return r.right;
}

/** Section heading with the hairline above it; returns the y below it. */
static int heading(HDC dc, int x, int y, int w, const wchar_t *t) {
  RECT line = { x, y, x + w, y + 1 };
  fillRect(dc, line, C_LINE);
  y += S(16);
  if (t) {
    RECT r = { x, y, x + w, y + S(16) };
    text(dc, t, r, fH2, C_DIM, DT_SINGLELINE);
    y += S(26);
  }
  return y;
}

/** A status line: dot, bold label, dim text. */
static int statusRow(HDC dc, int x, int y, int w, COLORREF c, const wchar_t *label, const wchar_t *value) {
  int h = S(24);
  dot(dc, x, y + h / 2, c);
  RECT l = { x + S(18), y, x + S(110), y + h };
  text(dc, label, l, fBold, C_TEXT, DT_VCENTER | DT_SINGLELINE);
  RECT v = { x + S(112), y, x + w, y + h };
  text(dc, value, v, fBody, C_DIM, DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
  return y + h;
}

/** Wrapped paragraph; returns the y below it. */
static int para(HDC dc, int x, int y, int w, const wchar_t *t, HFONT f, COLORREF c) {
  int h = textH(dc, t, w, f);
  RECT r = { x, y, x + w, y + h };
  text(dc, t, r, f, c, DT_WORDBREAK);
  return y + h;
}

// ---------------------------------------------------------------- the page

static void paint(HDC dc, int cw, int ch) {
  RECT all = { 0, 0, cw, ch };
  fillRect(dc, all, C_BG);
  nhits = 0;
  int pad = S(20), x = pad, w = cw - 2 * pad, y = S(18) - scrollY;
  wchar_t b[600];
  RECT pwWant = { 0 };

  // header
  dot(dc, x, y + S(13), C_RED);
  RECT t = { x + S(20), y, x + w, y + S(26) };
  text(dc, L"OBS Remote", t, fTitle, C_TEXT, DT_VCENTER | DT_SINGLELINE);
  text(dc, st.host, t, fSmall, C_DIM, DT_VCENTER | DT_SINGLELINE | DT_RIGHT | DT_END_ELLIPSIS);
  y += S(42);

  if (!st.ok) {
    y = statusRow(dc, x, y, w, C_WARN, L"OBS Remote", L"not running");
    y += S(10);
    RECT box = { x, y, x + w, y };
    int h = textH(dc, L"Open OBS Studio: OBS Remote starts with it. This window connects by itself.", w - S(24), fBody);
    box.bottom = y + h + S(20);
    fillRect(dc, box, RGB(0x2a, 0x24, 0x18));
    RECT bar = { x, y, x + S(3), box.bottom };
    fillRect(dc, bar, C_WARN);
    para(dc, x + S(14), y + S(10), w - S(24), L"Open OBS Studio: OBS Remote starts with it. This window connects by itself.", fBody, C_TEXT);
    y = box.bottom + S(16);
    contentH = y + scrollY;
    if (pwEdit && IsWindowVisible(pwEdit)) ShowWindow(pwEdit, SW_HIDE);
    return;
  }

  // status
  int obsOk = !wcscmp(st.obs, L"connected"), obsAuth = !wcscmp(st.obs, L"auth");
  if (obsOk) swprintf(b, 600, L"connected · %ls", st.obsDetail); else wcscpy(b, obsAuth ? L"wrong WebSocket password" : L"waiting for OBS");
  y = statusRow(dc, x, y, w, obsOk ? C_OK : obsAuth || !wcscmp(st.obs, L"refused") ? C_BAD : C_WARN, L"OBS Studio", b);
  int relUp = !wcscmp(st.relay, L"up");
  y = statusRow(dc, x, y, w, relUp ? C_OK : !wcscmp(st.relay, L"down") ? C_BAD : C_WARN, L"Server", relUp ? L"connected" : st.relayDetail[0] ? st.relayDetail : L"connecting…");
  if (st.hasTunnel) {
    int up = !wcscmp(st.tun, L"up");
    y = statusRow(dc, x, y, w, up ? C_OK : !wcscmp(st.tun, L"blocked") || !wcscmp(st.tun, L"error") ? C_BAD : C_WARN, L"Public link",
                  up ? st.tunUrl + (wcsncmp(st.tunUrl, L"https://", 8) ? 0 : 8) : st.tunDetail[0] ? st.tunDetail : L"starting…");
  }
  int online = onlineCount();
  swprintf(b, 600, L"%d online · %d paired", online, st.ndev);
  y = statusRow(dc, x, y, w, online ? C_OK : RGB(0x55, 0x55, 0x5b), L"Devices", b);

  if (!obsOk && !obsAuth) {
    const wchar_t *hint = !st.obsws ? L"OBS's WebSocket server is switched off. In OBS: Tools → WebSocket Server Settings → tick “Enable WebSocket server”." : L"Start OBS Studio. This window updates by itself.";
    y += S(10);
    int h = textH(dc, hint, w - S(24), fBody);
    RECT box = { x, y, x + w, y + h + S(20) };
    fillRect(dc, box, RGB(0x2a, 0x24, 0x18));
    RECT bar = { x, y, x + S(3), box.bottom };
    fillRect(dc, bar, C_WARN);
    para(dc, x + S(14), y + S(10), w - S(24), hint, fBody, C_TEXT);
    y = box.bottom;
  }
  if (obsAuth) {
    y += S(12);
    RECT l = { x, y, x + w, y + S(20) };
    text(dc, L"obs-websocket password", l, fBody, C_TEXT, DT_SINGLELINE);
    y += S(24);
    pwWant = (RECT){ x + S(8), y + S(8), x + w - S(90) - S(8), y + S(26) };
    RECT field = { x, y, x + w - S(90), y + S(34) };
    roundRect(dc, field, S(10), C_FIELD, C_LINE);
    button(dc, x + w - S(80), y, S(80), L"Save", B_NORMAL, H_PWSAVE, 0);
    y += S(40);
    y = para(dc, x, y, w, L"OBS → Tools → WebSocket Server Settings → Show Connect Info.", fSmall, C_DIM);
  }
  y += S(18);

  // connect a phone
  y = heading(dc, x, y, w, L"CONNECT A PHONE OR TABLET");
  const wchar_t *roles[] = { L"Full control", L"Control", L"View only" };
  int bx = x;
  for (int i = 0; i < 3; i++) bx = button(dc, bx, y, 0, roles[i], role == i ? B_ON : B_NORMAL, H_ROLE, i) + S(6);
  button(dc, bx + S(4), y, 0, pair.active ? L"New code" : L"Show code", B_PRIMARY, H_CODE, 0);
  y += S(44);
  if (pair.active) {
    int q = S(184), cell = (q - S(20)) / pair.n, qs = cell * pair.n + S(20);
    RECT qr = { x, y, x + qs, y + qs };
    roundRect(dc, qr, S(12), RGB(255, 255, 255), RGB(255, 255, 255));
    HBRUSH black = CreateSolidBrush(RGB(0, 0, 0));
    for (int yy = 0; yy < pair.n; yy++)
      for (int xx = 0; xx < pair.n; xx++)
        if (pair.m[yy * pair.n + xx]) { RECT m = { x + S(10) + xx * cell, y + S(10) + yy * cell, x + S(10) + (xx + 1) * cell, y + S(10) + (yy + 1) * cell }; FillRect(dc, &m, black); }
    DeleteObject(black);
    int tx = x + qs + S(16), tw = w - qs - S(16), ty = y + S(6);
    if (tw < S(150)) { tx = x; tw = w; ty = y + qs + S(12); }
    RECT r = { tx, ty, tx + tw, ty + S(18) };
    text(dc, L"Scan with the camera, or type", r, fSmall, C_DIM, DT_SINGLELINE);
    ty += S(22);
    wchar_t roomUp[32];
    CPY(roomUp, pair.room);
    _wcsupr(roomUp);
    r = (RECT){ tx, ty, tx + tw, ty + S(18) };
    text(dc, roomUp, r, fMono, C_DIM, DT_SINGLELINE);
    ty += S(20);
    wchar_t code[40] = L"";
    for (int i = 0, o = 0; pair.code[i] && o < 38; i++) { if (i && i % 4 == 0) code[o++] = L'-'; code[o++] = pair.code[i]; code[o] = 0; }
    r = (RECT){ tx, ty, tx + tw, ty + S(30) };
    text(dc, code, r, fCode, C_TEXT, DT_SINGLELINE);
    ty += S(40);
    button(dc, tx, ty, 0, L"Copy link", B_NORMAL, H_COPY, 0);
    ty += S(42);
    int left = (int)((pair.exp - nowMs()) / 1000);
    if (left < 0) left = 0;
    swprintf(b, 600, L"Code valid for %d:%02d", left / 60, left % 60);
    r = (RECT){ tx, ty, tx + tw, ty + S(18) };
    text(dc, b, r, fSmall, C_DIM, DT_SINGLELINE);
    ty += S(22);
    y = max(y + qs, ty) + S(10);
  }
  if (pairMsg[0]) y = para(dc, x, y, w, pairMsg, fBody, C_OK) + S(8);
  if (pairErr[0]) y = para(dc, x, y, w, pairErr, fBody, C_BAD) + S(8);
  button(dc, x, y, w, L"Open the control page on this computer", B_NORMAL, H_PAGE, 0);
  y += S(52);

  // connection mode
  if (st.canSwitch) {
    y = heading(dc, x, y, w, L"HOW PHONES REACH THIS COMPUTER");
    int half = (w - S(8)) / 2;
    for (int i = 0; i < 2; i++) {
      int on = !wcscmp(st.mode, i ? L"local" : L"cloud");
      RECT r = { x + i * (half + S(8)), y, x + i * (half + S(8)) + half, y + S(58) };
      roundRect(dc, r, S(10), hoverId == H_MODE && hoverArg == i ? C_BTN_HI : C_BTN, on ? C_ACC : C_BTN_LINE);
      RECT tr = { r.left + S(12), r.top + S(8), r.right - S(8), r.top + S(28) };
      text(dc, i ? L"100% on this computer" : st.cloudHost[0] ? st.cloudHost : L"Online server", tr, fBold, C_TEXT, DT_SINGLELINE | DT_END_ELLIPSIS);
      RECT sr = { r.left + S(12), r.top + S(30), r.right - S(8), r.bottom - S(6) };
      text(dc, i ? L"free link, changes on restart" : L"permanent link, works anywhere", sr, fSmall, C_DIM, DT_SINGLELINE | DT_END_ELLIPSIS);
      addHit(r, H_MODE, i);
    }
    y += S(66);
    if (modeMsg[0]) y = para(dc, x, y, w, modeMsg, fSmall, C_DIM) + S(6);
    y += S(12);
  }

  // devices
  y = heading(dc, x, y, w, L"CONNECTED DEVICES");
  if (!st.ndev) y = para(dc, x, y, w, L"No device has connected yet.", fBody, C_DIM) + S(10);
  for (int i = 0; i < st.ndev; i++) {
    Dev *d = &st.dev[i];
    int h = S(38);
    if (i) { RECT l = { x, y, x + w, y + 1 }; fillRect(dc, l, C_LINE); }
    dot(dc, x, y + h / 2, d->online ? C_OK : RGB(0x55, 0x55, 0x5b));
    const wchar_t *tag = !wcscmp(d->role, L"viewer") ? L"view only" : !wcscmp(d->role, L"operator") ? L"control" : L"full";
    int rw = textW(dc, L"Remove", fBody) + S(28), tw = textW(dc, tag, fMono) + S(12);
    RECT nm = { x + S(18), y, x + w - rw - tw - S(16), y + h };
    text(dc, d->name, nm, fBody, C_TEXT, DT_VCENTER | DT_SINGLELINE | DT_END_ELLIPSIS);
    RECT tg = { x + w - rw - tw - S(8), y + S(10), x + w - rw - S(8), y + h - S(10) };
    roundRect(dc, tg, S(6), C_BG, C_LINE);
    text(dc, tag, tg, fMono, C_DIM, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    button(dc, x + w - rw, y + S(2), rw, L"Remove", B_DANGER, H_REVOKE, i);
    y += h;
  }
  y += S(14);

  // slides
  {
    RECT box = { x, y + S(3), x + S(16), y + S(19) };
    roundRect(dc, box, S(5), st.presentKeys ? C_ACC : C_FIELD, st.presentKeys ? C_ACC : C_BTN_LINE);
    if (st.presentKeys) text(dc, L"✓", box, fBold, RGB(0x14, 0x14, 0x16), DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    const wchar_t *lab = L"Let paired devices flip PowerPoint / PDF pages (sends Page Up / Page Down to the window in front on this computer)";
    int h = textH(dc, lab, w - S(28), fBody);
    RECT lr = { x + S(26), y, x + w, y + h };
    text(dc, lab, lr, fBody, C_TEXT, DT_WORDBREAK);
    RECT hit = { x, y, x + w, y + h };
    addHit(hit, H_SLIDES, 0);
    y += h + S(16);
  }

  y = heading(dc, x, y, w, NULL);
  bx = x - S(6);
  if (!st.hosted) bx = button(dc, bx, y, 0, L"Quit OBS Remote", B_QUIET, H_QUIT, 0) + S(4);
  button(dc, bx, y, 0, uninstallSure ? L"Click again to remove everything" : L"Uninstall…", B_DANGER, H_UNINSTALL, 0);
  y += S(44);
  swprintf(b, 600, L"%ls · room %ls", st.url, st.room);
  y = para(dc, x, y, w, b, fMono, C_DIM) + S(18);
  contentH = y + scrollY;

  // the one real input box (password) follows the layout
  if (obsAuth) {
    if (!EqualRect(&pwWant, &pwRect)) { pwRect = pwWant; MoveWindow(pwEdit, pwWant.left, pwWant.top, pwWant.right - pwWant.left, pwWant.bottom - pwWant.top, TRUE); }
    if (!IsWindowVisible(pwEdit)) ShowWindow(pwEdit, SW_SHOW);
  } else if (IsWindowVisible(pwEdit)) ShowWindow(pwEdit, SW_HIDE);
}

static void repaint(void) { InvalidateRect(wnd, NULL, FALSE); }

static void clampScroll(void) {
  RECT rc;
  GetClientRect(wnd, &rc);
  int maxS = contentH - rc.bottom;
  if (maxS < 0) maxS = 0;
  if (scrollY > maxS) scrollY = maxS;
  if (scrollY < 0) scrollY = 0;
}

static void click(int id, int arg) {
  char body[200];
  switch (id) {
    case H_ROLE: role = arg; break;
    case H_CODE: {
      pairErr[0] = pairMsg[0] = 0;
      snprintf(body, sizeof body, "{\"role\":\"%s\"}", role == 2 ? "viewer" : role == 1 ? "operator" : "owner");
      run(A_PAIR, L"/api/pair?fmt=txt", body);
      break;
    }
    case H_COPY: copyText(pair.url); pairMsg[0] = 0; wcscpy(pairMsg, L"Link copied."); break;
    case H_PAGE: run(A_SIMPLE, L"/api/open", NULL); break;
    case H_MODE:
      if (!wcscmp(st.mode, arg ? L"local" : L"cloud")) break;
      wcscpy(modeMsg, L"Switching… a new QR code is needed for phones paired in the other mode only the first time.");
      pair.active = 0;
      snprintf(body, sizeof body, "{\"mode\":\"%s\"}", arg ? "local" : "cloud");
      run(A_SIMPLE, L"/api/mode", body);
      break;
    case H_REVOKE: {
      if (arg >= st.ndev) break;
      wchar_t q[200];
      swprintf(q, 200, L"Remove “%ls”? It will be signed out.", st.dev[arg].name);
      if (MessageBoxW(wnd, q, L"OBS Remote", MB_YESNO | MB_ICONQUESTION) != IDYES) break;
      char cid[80];
      WideCharToMultiByte(CP_UTF8, 0, st.dev[arg].cid, -1, cid, sizeof cid, NULL, NULL);
      snprintf(body, sizeof body, "{\"cid\":\"%s\"}", cid);
      run(A_SIMPLE, L"/api/revoke", body);
      break;
    }
    case H_SLIDES:
      st.presentKeys = !st.presentKeys;
      snprintf(body, sizeof body, "{\"on\":%s}", st.presentKeys ? "true" : "false");
      run(A_SIMPLE, L"/api/present-keys", body);
      break;
    case H_QUIT: run(A_SIMPLE, L"/api/quit", NULL); break;
    case H_UNINSTALL:
      if (!uninstallSure) { uninstallSure = 1; SetTimer(wnd, 2, 5000, NULL); break; }
      if (MessageBoxW(wnd, L"Remove OBS Remote, its OBS plugin and the saved pairing from this computer?", L"OBS Remote", MB_YESNO | MB_ICONWARNING) == IDYES) {
        run(A_SIMPLE, L"/api/uninstall", NULL);
        Sleep(400);
        DestroyWindow(wnd);
      }
      uninstallSure = 0;
      break;
    case H_PWSAVE: {
      wchar_t pw[200];
      GetWindowTextW(pwEdit, pw, 200);
      char json[600];
      jsonPassword(pw, json, sizeof json);
      SetWindowTextW(pwEdit, L"");
      run(A_SIMPLE, L"/api/obs-password", json);
      break;
    }
  }
  repaint();
}

static void finished(Done *d) {
  int ok = d->code == 200;
  wchar_t err[300];
  if (!ok) errorOf(d->body, err, 300);
  switch (d->kind) {
    case A_PAIR:
      if (ok && d->body) {
        parsePair(d->body);
        baseN = st.ndev; baseOnline = onlineCount();
        SetTimer(wnd, 1, 1000, NULL);
      } else wcscpy(pairErr, err);
      break;
    default:
      if (!ok) wcsncpy(pairErr, err, 199);
  }
  free(d->body);
  free(d);
  repaint();
}

static void onStatus(Status *s) {
  int restarted = st.ok && s->ok && s->started != lastStarted && lastStarted != 0;
  st = *s;
  free(s);
  if (st.ok) lastStarted = st.started;
  if (restarted) { pair.active = 0; modeMsg[0] = 0; }
  // the scan worked: hide the QR so it does not stay on a stream preview
  if (pair.active && baseN >= 0 && (st.ndev > baseN || onlineCount() > baseOnline)) {
    pair.active = 0;
    baseN = -1;
    swprintf(pairMsg, 200, L"Connected: %ls. The code is hidden.", st.ndev ? st.dev[st.ndev - 1].name : L"new device");
  }
  if (pair.active && pair.exp && pair.exp < nowMs()) { pair.active = 0; wcscpy(pairErr, L"Code expired. Press Show code for a new one."); }
  repaint();
}

static LRESULT CALLBACK proc(HWND h, UINT m, WPARAM wp, LPARAM lp) {
  switch (m) {
    case WM_CREATE: {
      BOOL dark = TRUE;
      DwmSetWindowAttribute(h, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof dark);
      pwEdit = CreateWindowExW(0, L"EDIT", L"", WS_CHILD | ES_PASSWORD | ES_AUTOHSCROLL, 0, 0, 10, 10, h, (HMENU)10, inst, NULL);
      SendMessageW(pwEdit, WM_SETFONT, (WPARAM)fBody, TRUE);
      return 0;
    }
    case WM_CTLCOLOREDIT: {
      static HBRUSH field;
      if (!field) field = CreateSolidBrush(C_FIELD);
      SetTextColor((HDC)wp, C_TEXT);
      SetBkColor((HDC)wp, C_FIELD);
      return (LRESULT)field;
    }
    case WM_ERASEBKGND: return 1;
    case WM_PAINT: {
      PAINTSTRUCT ps;
      HDC dc = BeginPaint(h, &ps);
      RECT rc;
      GetClientRect(h, &rc);
      HDC mem = CreateCompatibleDC(dc);
      HBITMAP bmp = CreateCompatibleBitmap(dc, rc.right, rc.bottom);
      HGDIOBJ old = SelectObject(mem, bmp);
      paint(mem, rc.right, rc.bottom);
      BitBlt(dc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
      SelectObject(mem, old);
      DeleteObject(bmp);
      DeleteDC(mem);
      EndPaint(h, &ps);
      return 0;
    }
    case WM_SIZE: clampScroll(); repaint(); return 0;
    case WM_MOUSEWHEEL: scrollY -= GET_WHEEL_DELTA_WPARAM(wp) * S(60) / WHEEL_DELTA; clampScroll(); pwRect = (RECT){ 0 }; repaint(); return 0;
    case WM_MOUSEMOVE: {
      POINT p = { GET_X_LPARAM(lp), GET_Y_LPARAM(lp) };
      int id = H_NONE, arg = 0;
      for (int i = 0; i < nhits; i++) if (PtInRect(&hits[i].r, p)) { id = hits[i].id; arg = hits[i].arg; }
      SetCursor(LoadCursorW(NULL, id ? IDC_HAND : IDC_ARROW));
      if (id != hoverId || arg != hoverArg) {
        hoverId = id; hoverArg = arg;
        repaint();
        TRACKMOUSEEVENT t = { sizeof t, TME_LEAVE, h, 0 };
        TrackMouseEvent(&t);
      }
      return 0;
    }
    case WM_MOUSELEAVE: hoverId = H_NONE; repaint(); return 0;
    case WM_SETCURSOR: if (LOWORD(lp) == HTCLIENT) return TRUE; break;
    case WM_LBUTTONUP: {
      POINT p = { GET_X_LPARAM(lp), GET_Y_LPARAM(lp) };
      for (int i = nhits - 1; i >= 0; i--) if (PtInRect(&hits[i].r, p)) { click(hits[i].id, hits[i].arg); break; }
      return 0;
    }
    case WM_TIMER:
      if (wp == 2) { KillTimer(h, 2); uninstallSure = 0; }
      if (wp == 1 && !pair.active) KillTimer(h, 1);
      repaint();
      return 0;
    case WM_APP_STATUS: onStatus((Status *)lp); return 0;
    case WM_APP_DONE: finished((Done *)lp); return 0;
    case WM_DPICHANGED: {
      dpi = HIWORD(wp);
      makeFonts();
      RECT *r = (RECT *)lp;
      SetWindowPos(h, NULL, r->left, r->top, r->right - r->left, r->bottom - r->top, SWP_NOZORDER | SWP_NOACTIVATE);
      return 0;
    }
    case WM_GETMINMAXINFO: ((MINMAXINFO *)lp)->ptMinTrackSize = (POINT){ S(380), S(320) }; return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(h, m, wp, lp);
}

int WINAPI wWinMain(HINSTANCE hi, HINSTANCE prev, PWSTR cmd, int show) {
  (void)prev; (void)cmd;
  inst = hi;
  InitializeCriticalSection(&tokenLock);
  wchar_t env[8];
  if (GetEnvironmentVariableW(L"OBSR_PORT", env, 8)) port = (unsigned short)_wtoi(env);
  int argc;
  wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; argv && i < argc; i++) {
    if (!wcsncmp(argv[i], L"--port=", 7)) port = (unsigned short)_wtoi(argv[i] + 7);
  }
  if (!port) port = 47890;

  // One window only: a second start brings the first one forward.
  CreateMutexW(NULL, FALSE, L"Local\\OBSRemoteSettings");
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    HWND other = FindWindowW(APP_CLASS, NULL);
    if (other) {
      ShowWindow(other, IsIconic(other) ? SW_RESTORE : SW_SHOW);
      SetForegroundWindow(other);
    }
    return 0;
  }

  typedef BOOL(WINAPI * dpiCtx)(HANDLE);
  dpiCtx setCtx = (dpiCtx)(void *)GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetProcessDpiAwarenessContext");
  if (setCtx) setCtx((HANDLE)-4 /* PER_MONITOR_AWARE_V2 */); else SetProcessDPIAware();
  HDC screen = GetDC(NULL);
  dpi = GetDeviceCaps(screen, LOGPIXELSY);
  ReleaseDC(NULL, screen);
  makeFonts();

  WNDCLASSEXW wc = { sizeof wc };
  wc.lpfnWndProc = proc;
  wc.hInstance = hi;
  wc.hIcon = LoadIconW(hi, MAKEINTRESOURCEW(1));
  wc.hIconSm = wc.hIcon;
  wc.hCursor = LoadCursorW(NULL, IDC_ARROW);
  wc.lpszClassName = APP_CLASS;
  RegisterClassExW(&wc);
  wnd = CreateWindowExW(0, APP_CLASS, L"OBS Remote", WS_OVERLAPPEDWINDOW, CW_USEDEFAULT, CW_USEDEFAULT, S(460), S(820), NULL, NULL, hi, NULL);
  if (!wnd) return 1;
  // the monitor the window landed on may use another scale than the main screen
  typedef UINT(WINAPI * dpiFor)(HWND);
  dpiFor getDpi = (dpiFor)(void *)GetProcAddress(GetModuleHandleW(L"user32.dll"), "GetDpiForWindow");
  if (getDpi && (int)getDpi(wnd) != dpi) {
    dpi = (int)getDpi(wnd);
    makeFonts();
    SetWindowPos(wnd, NULL, 0, 0, S(460), S(820), SWP_NOMOVE | SWP_NOZORDER);
  }
  ShowWindow(wnd, show);
  UpdateWindow(wnd);
  HANDLE t = CreateThread(NULL, 0, poller, NULL, 0, NULL);
  if (t) CloseHandle(t);

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) {
    if (msg.message == WM_KEYDOWN && msg.hwnd == pwEdit && msg.wParam == VK_RETURN) { click(H_PWSAVE, 0); continue; }
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }
  return 0;
}
