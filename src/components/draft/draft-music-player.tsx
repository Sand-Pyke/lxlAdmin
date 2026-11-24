'use client';

import { CheckOutlined, PauseOutlined, PlayCircleOutlined, SoundOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

export type DraftMusicTrack = { name: string; src: string };

export function DraftMusicPlayer({ tracks }: { tracks: DraftMusicTrack[] }) {
  const [selected, setSelected] = useState(tracks[0]);
  const [playing, setPlaying] = useState(false);
  const [open, setOpen] = useState(false);
  const [volume, setVolume] = useState(45);
  const [error, setError] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);
  // Switching src happens in the click handler; keep React from loading it again on render.
  const initialSource = useRef(tracks[0]?.src);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const enabledRef = useRef(false);
  const pendingRef = useRef(false);
  const playVersion = useRef(0);
  const panelId = useId();

  const play = useCallback(async (showError = true) => {
    const audio = audioRef.current;
    if (!audio) return;
    const version = ++playVersion.current;
    enabledRef.current = true;
    pendingRef.current = true;
    setError('');
    try {
      await audio.play();
      if (version !== playVersion.current || !enabledRef.current || audio.paused) return;
      setPlaying(true);
      channelRef.current?.postMessage({ type: 'playing' });
    } catch {
      if (version !== playVersion.current) return;
      setPlaying(false);
      if (showError) setError('暂时无法播放，请点击播放重试或选择其他歌曲');
    } finally {
      if (version === playVersion.current) pendingRef.current = false;
    }
  }, []);

  const pause = () => {
    enabledRef.current = false;
    playVersion.current++;
    pendingRef.current = false;
    audioRef.current?.pause();
    setPlaying(false);
  };

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel('lxl-draft-music');
    channelRef.current = channel;
    channel.onmessage = (event) => {
      if (event.data?.type !== 'playing') return;
      playVersion.current++;
      pendingRef.current = false;
      audioRef.current?.pause();
      setPlaying(false);
    };
    return () => {
      playVersion.current++;
      channel.close();
      channelRef.current = null;
    };
  }, []);

  useEffect(() => {
    const resume = () => {
      if (!document.hidden && enabledRef.current && audioRef.current?.paused) void play(false);
    };
    document.addEventListener('visibilitychange', resume);
    return () => document.removeEventListener('visibilitychange', resume);
  }, [play]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume / 100;
  }, [volume]);

  function choose(track: DraftMusicTrack) {
    const audio = audioRef.current;
    if (!audio) return;
    if (selected?.src !== track.src) {
      playVersion.current++;
      audio.pause();
      audio.src = track.src;
      audio.load();
      setSelected(track);
    }
    void play();
  }

  function toggle() {
    if (!audioRef.current?.paused || pendingRef.current) pause();
    else if (selected) void play();
  }

  return (
    <div
      className="big-draft-music-player"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={(event) => {
        if (!event.currentTarget.contains(document.activeElement)) setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          setOpen(false);
          event.stopPropagation();
        }
      }}
    >
      <audio
        ref={audioRef}
        src={initialSource.current}
        loop
        preload="none"
        onPause={() => setPlaying(false)}
        onError={() => {
          pause();
          setError('歌曲加载失败，请选择其他歌曲或重试');
        }}
      />
      <button
        type="button"
        className={`big-draft-music-toggle${playing ? ' is-playing' : ''}`}
        disabled={!tracks.length}
        onClick={() => {
          setOpen(true);
          toggle();
        }}
        aria-label={playing ? '暂停背景音乐，展开歌曲列表' : '播放背景音乐，展开歌曲列表'}
        aria-pressed={playing}
        aria-expanded={open}
        aria-controls={panelId}
        title={selected ? `${selected.name} · ${playing ? '暂停' : '播放'}` : '暂无背景音乐'}
      >
        <span>
          <SoundOutlined />
        </span>
      </button>
      {open && (
        <div className="big-draft-music-popover" id={panelId}>
          <section className="big-draft-music-panel" aria-label="背景音乐播放器">
            <div className="big-draft-music-heading">
              <div>
                <small>背景音乐</small>
                <strong>{selected?.name || '暂无歌曲'}</strong>
              </div>
              <button
                type="button"
                onClick={toggle}
                disabled={!tracks.length}
                aria-label={playing ? '暂停背景音乐' : '播放背景音乐'}
              >
                {playing ? <PauseOutlined /> : <PlayCircleOutlined />}
              </button>
            </div>
            <ul className="big-draft-music-list" aria-label="歌曲列表">
              {tracks.map((track) => (
                <li key={track.src}>
                  <button
                    type="button"
                    onClick={() => choose(track)}
                    className={selected?.src === track.src ? 'is-selected' : ''}
                    aria-pressed={selected?.src === track.src}
                  >
                    <span>{track.name}</span>
                    {selected?.src === track.src ? <CheckOutlined /> : <PlayCircleOutlined />}
                  </button>
                </li>
              ))}
            </ul>
            <label className="big-draft-music-volume">
              <SoundOutlined />
              <input
                type="range"
                min={0}
                max={100}
                value={volume}
                aria-label="背景音乐音量"
                onChange={(event) => setVolume(Number(event.target.value))}
              />
              <span>{volume}%</span>
            </label>
            {error && (
              <p className="big-draft-music-error" role="status">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
