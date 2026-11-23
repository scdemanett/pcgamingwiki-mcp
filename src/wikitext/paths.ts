/**
 * `{{p|token}}` → rendered path prefix, exactly as PCGW stores paths in Cargo
 * (`GameData.Paths`). Copied from Module:Cargo/gamePaths (checked 22 Nov 2026;
 * recorded in test/fixtures/spike/module-cargo-gamepaths.json), so wikitext mode
 * and Cargo mode return the same path strings.
 */
export const PATH_TOKENS: Readonly<Record<string, string>> = {
  // Generic
  game: "<path-to-game>",
  uid: "<user-id>",
  steam: "<Steam-folder>",
  steamlibrary: "<SteamLibrary-folder>",
  uplay: "<Ubisoft-Connect-folder>",
  ubisoftconnect: "<Ubisoft-Connect-folder>",
  // Windows > Registry
  hkey_current_user: "HKEY_CURRENT_USER",
  hkcu: "HKEY_CURRENT_USER",
  hkey_local_machine: "HKEY_LOCAL_MACHINE",
  hklm: "HKEY_LOCAL_MACHINE",
  wow64: "Wow6432Node",
  // Windows > Drive
  username: "%USERNAME%",
  "userprofile\\appdata\\locallow": "%USERPROFILE%\\AppData\\LocalLow",
  "userprofile\\documents": "%USERPROFILE%\\Documents",
  userprofile: "%USERPROFILE%",
  appdata: "%APPDATA%",
  localappdata: "%LOCALAPPDATA%",
  temp: "%TEMP%",
  public: "%PUBLIC%",
  allusersprofile: "%PROGRAMDATA%",
  programdata: "%PROGRAMDATA%",
  programfiles: "%PROGRAMFILES%",
  windir: "%WINDIR%",
  syswow64: "SysWOW64",
  // OS X
  machome: "$HOME",
  osxhome: "$HOME",
  // Linux
  linuxhome: "$HOME",
  xdgdatahome: "$XDG_DATA_HOME",
  xdgconfighome: "$XDG_CONFIG_HOME",
};

/** Rendered form of one token; unknown tokens stay visible as `{{p|token}}`. */
export function renderPathToken(token: string): string {
  const t = token.trim().toLowerCase();
  return PATH_TOKENS[t] ?? `{{p|${t}}}`;
}
