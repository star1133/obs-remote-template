// OBS Remote plugin for OBS Studio (Windows). It starts the OBS Remote agent when OBS starts and stops it when OBS
// closes, so the remote lives inside OBS: no tray icon, nothing starting with Windows.
// It does not link against libobs: OBS only needs the exports below, and logging/menu functions are looked up at
// runtime. Build: gcc -shared -O2 -s -o obs-remote.dll obs-remote.c -lws2_32 -lshell32 -static-libgcc
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <windows.h>
#include <shellapi.h>
#include <stdbool.h>

#define EXPORT __declspec(dllexport)
#define SETUP_PORT 47890 // the agent's local page; OBSR_PORT overrides it, as in the agent
#define LOG_INFO 300
#define LOG_WARNING 200

static void *module_ptr;
static HANDLE job; // the agent and everything it starts (Cloudflare tunnel) die with this handle, even if OBS crashes

EXPORT void obs_module_set_pointer(void *m) { module_ptr = m; }
EXPORT void *obs_current_module(void) { return module_ptr; }
EXPORT unsigned int obs_module_ver(void) { return 28u << 24; } // libobs 28.0.0, the first OBS with obs-websocket built in
EXPORT const char *obs_module_name(void) { return "OBS Remote"; }
EXPORT const char *obs_module_description(void) { return "Control OBS from your phone"; }

typedef void (*blog_fn)(int, const char *, ...);
#define LOG(level, ...) do { blog_fn b = (blog_fn)(void *)GetProcAddress(GetModuleHandleW(L"obs.dll"), "blog"); \
  if (b) b(level, "[obs-remote] " __VA_ARGS__); } while (0)

/** %OBSR_HOME% or %LOCALAPPDATA%\OBS Remote, the same folder the agent uses. */
static bool agent_dir(wchar_t *out, DWORD n) {
  DWORD len = GetEnvironmentVariableW(L"OBSR_HOME", out, n);
  if (len > 0 && len < n) return true;
  len = GetEnvironmentVariableW(L"LOCALAPPDATA", out, n);
  if (len == 0 || len + 12 >= n) return false;
  lstrcatW(out, L"\\OBS Remote");
  return true;
}

static unsigned short setup_port(void) {
  wchar_t v[8];
  DWORD len = GetEnvironmentVariableW(L"OBSR_PORT", v, 8);
  int n = 0;
  for (DWORD i = 0; i < len && len < 8 && v[i] >= L'0' && v[i] <= L'9'; i++) n = n * 10 + (v[i] - L'0');
  return n > 0 && n < 65536 ? (unsigned short)n : SETUP_PORT;
}

/** True once the agent's local page answers. Short non-blocking tries: a refused localhost connect takes ~2 s on Windows. */
static bool port_open(unsigned short port) {
  SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (s == INVALID_SOCKET) return false;
  u_long nb = 1;
  ioctlsocket(s, FIONBIO, &nb);
  struct sockaddr_in a = { 0 };
  a.sin_family = AF_INET;
  a.sin_port = htons(port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  connect(s, (struct sockaddr *)&a, sizeof a);
  fd_set w, e;
  FD_ZERO(&w); FD_SET(s, &w); FD_ZERO(&e); FD_SET(s, &e);
  struct timeval tv = { 0, 250000 };
  bool ok = select(0, NULL, &w, &e, &tv) > 0 && FD_ISSET(s, &w);
  closesocket(s);
  return ok;
}

/** Tools → OBS Remote: the native settings window next to the agent; the local web page if it is missing. */
static void open_settings(void *data) {
  (void)data;
  wchar_t dir[MAX_PATH], exe[MAX_PATH + 32], args[24];
  if (agent_dir(dir, MAX_PATH)) {
    wsprintfW(exe, L"%s\\obs-remote-settings.exe", dir);
    wsprintfW(args, L"--port=%u", setup_port());
    if (GetFileAttributesW(exe) != INVALID_FILE_ATTRIBUTES && (INT_PTR)ShellExecuteW(NULL, L"open", exe, args, dir, SW_SHOWNORMAL) > 32) return;
  }
  wchar_t url[40];
  wsprintfW(url, L"http://127.0.0.1:%u/", setup_port());
  ShellExecuteW(NULL, L"open", url, NULL, NULL, SW_SHOWNORMAL);
}

typedef void (*add_menu_fn)(const char *, void (*)(void *), void *);

EXPORT bool obs_module_load(void) {
  wchar_t dir[MAX_PATH], exe[MAX_PATH], cmd[MAX_PATH + 64];
  if (!agent_dir(dir, MAX_PATH)) return true;
  lstrcpyW(exe, dir);
  lstrcatW(exe, L"\\obs-remote.exe");
  if (GetFileAttributesW(exe) == INVALID_FILE_ATTRIBUTES) {
    LOG(LOG_WARNING, "agent not found; run OBS-Remote-Setup.exe again");
    return true; // never stop OBS from starting
  }

  add_menu_fn add_menu = (add_menu_fn)(void *)GetProcAddress(GetModuleHandleW(L"obs-frontend-api.dll"), "obs_frontend_add_tools_menu_item");
  if (add_menu) add_menu("OBS Remote", open_settings, NULL);

  job = CreateJobObjectW(NULL, NULL);
  if (job) {
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION li = { 0 };
    li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &li, sizeof li);
  }

  wsprintfW(cmd, L"\"%s\" run --hosted --parent %lu", exe, GetCurrentProcessId());
  STARTUPINFOW si = { sizeof si };
  PROCESS_INFORMATION pi;
  if (!CreateProcessW(exe, cmd, NULL, NULL, FALSE, CREATE_NO_WINDOW | CREATE_SUSPENDED, NULL, dir, &si, &pi)) {
    LOG(LOG_WARNING, "could not start the agent (error %lu)", GetLastError());
    return true;
  }
  if (job && !AssignProcessToJobObject(job, pi.hProcess)) LOG(LOG_WARNING, "agent runs outside the job (error %lu)", GetLastError());
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);

  // Wait (at most 6 s) for the agent's page, so an OBS Remote dock left from older versions has something to show.
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) == 0) {
    unsigned short port = setup_port();
    DWORD end = GetTickCount() + 6000;
    while (!port_open(port) && GetTickCount() < end)
      if (WaitForSingleObject(pi.hProcess, 0) == WAIT_OBJECT_0) break; // it left (another copy already runs)
    WSACleanup();
  }
  CloseHandle(pi.hProcess);
  LOG(LOG_INFO, "agent started");
  return true;
}

EXPORT void obs_module_unload(void) {
  if (job) { CloseHandle(job); job = NULL; }
}
