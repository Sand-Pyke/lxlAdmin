export function draftMusicTracks(files: { name: string; isFile(): boolean }[]) {
  return files
    .filter((file) => file.isFile() && /\.mp3$/i.test(file.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
    .map((file) => ({
      name: file.name.replace(/\.mp3$/i, ''),
      src: `/assets/music/${encodeURIComponent(file.name)}`,
    }));
}
