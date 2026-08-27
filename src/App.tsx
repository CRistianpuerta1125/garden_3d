import { useEffect, useRef, useState } from 'react';
import { GardenEngine } from './garden/engine';
import type { GardenParams, GardenStats } from './garden/engine';

const DEFAULTS: GardenParams = {
  timeOfDay: 10.6,
  wind: 1.0,
  flowerDensity: 0.7,
  grassDensity: 0.8,
  fireflies: true,
  petals: true,
  butterflies: true,
  bloom: 0.75,
  autoRotate: true,
  sound: false,
};

function fmtTime(h: number) {
  const hh = Math.floor(h) % 24;
  const mm = Math.floor((h % 1) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/* ---------- controles ---------- */

function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  const p = ((props.value - props.min) / (props.max - props.min)) * 100;
  return (
    <label className="block">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-[#93a88e]">
          {props.label}
        </span>
        <span className="font-mono text-[11px] text-[#e6c26a]">{props.display}</span>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
        className="mt-1.5 w-full"
        style={{
          background: `linear-gradient(to right, #a8d860 ${p}%, #223527 ${p}%)`,
        }}
      />
    </label>
  );
}

function Toggle(props: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => props.onChange(!props.on)}
      className="group flex w-full items-center justify-between py-[3px] text-left"
    >
      <span className="text-[12px] text-[#c9d6c0] transition-colors group-hover:text-[#e8efdd]">
        {props.label}
      </span>
      <span
        className={`relative h-[16px] w-[30px] rounded-full border transition-colors ${
          props.on ? 'border-[#a8d860]/60 bg-[#a8d860]/25' : 'border-[#3a4d3d] bg-[#141f16]'
        }`}
      >
        <span
          className={`absolute top-[2px] h-[10px] w-[10px] rounded-full transition-all ${
            props.on ? 'left-[15px] bg-[#a8d860]' : 'left-[3px] bg-[#5c705a]'
          }`}
        />
      </span>
    </button>
  );
}

function SectionTitle(props: { children: string }) {
  return (
    <div className="mb-2 mt-4 flex items-center gap-2 first:mt-0">
      <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[#6f8a6c]">
        {props.children}
      </span>
      <span className="h-px flex-1 bg-[#22331f]" />
    </div>
  );
}

function Stat(props: { k: string; v: string }) {
  return (
    <div className="min-w-[74px]">
      <div className="text-[9px] uppercase tracking-[0.18em] text-[#6f8a6c]">{props.k}</div>
      <div className="font-mono text-[13px] leading-tight text-[#e8efdd]">{props.v}</div>
    </div>
  );
}

/* ---------- iconos ---------- */

const IconLeaf = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
    <path d="M5 19c0-8 5-13 14-14-1 9-6 14-14 14Z" strokeLinejoin="round" />
    <path d="M5 19c3-5 6-8 10-10" strokeLinecap="round" />
  </svg>
);

const IconSliders = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
    <path d="M4 8h10M18 8h2M4 16h4M12 16h8" strokeLinecap="round" />
    <circle cx="15" cy="8" r="2" />
    <circle cx="9" cy="16" r="2" />
  </svg>
);

/* ---------- App ---------- */

export default function App() {
  const mountRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<GardenEngine | null>(null);
  const [params, setParams] = useState<GardenParams>(DEFAULTS);
  const [stats, setStats] = useState<GardenStats | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!mountRef.current) return;
    let engine: GardenEngine | null = null;
    try {
      engine = new GardenEngine(
        mountRef.current,
        params,
        setStats,
        () => {
          setStatus('ready');
          console.info('[Jardín Silvestre] escena 3D lista');
        },
        (m) => {
          setStatus('error');
          setErrorMsg(m);
        }
      );
      engineRef.current = engine;
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
    const onWinError = (e: ErrorEvent) => {
      setStatus((s) => (s === 'ready' ? s : 'error'));
      setErrorMsg(e.message || 'Error inesperado al iniciar la escena');
    };
    window.addEventListener('error', onWinError);
    // red de seguridad: si la pestaña nace oculta, rAF no dispara el onReady
    const fallback = window.setTimeout(
      () => setStatus((s) => (s === 'loading' ? 'ready' : s)),
      7000
    );
    return () => {
      window.clearTimeout(fallback);
      window.removeEventListener('error', onWinError);
      engine?.dispose();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(() => {
    engineRef.current?.setParams(params);
  }, [params]);

  const set = <K extends keyof GardenParams>(key: K, value: GardenParams[K]) =>
    setParams((p) => ({ ...p, [key]: value }));

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#070d09] text-[#e8efdd]">
      {/* Lienzo 3D */}
      <div ref={mountRef} className="absolute inset-0" />

      {/* Viñeta sutil */}
      <div className="pointer-events-none absolute inset-0 shadow-[inset_0_0_180px_rgba(0,0,0,0.55)]" />

      {/* Cabecera */}
      <header className="pointer-events-none absolute left-5 top-5 max-w-[380px] select-none sm:left-7 sm:top-7">
        <div className="flex items-center gap-2 text-[#a8d860]">
          {IconLeaf}
          <span className="text-[10px] font-semibold uppercase tracking-[0.3em]">
            Three.js · escena viva
          </span>
        </div>
        <h1 className="font-display mt-2 text-[40px] font-semibold italic leading-[0.95] text-[#f2f6e8] drop-shadow-[0_2px_18px_rgba(0,0,0,0.6)] sm:text-[52px]">
          Jardín
          <br />
          Silvestre
        </h1>
        <p className="mt-3 max-w-[300px] text-[12.5px] font-light leading-relaxed text-[#c2d1b8]/90">
          Hierba, pétalos y luciérnagas bajo un cielo que respira. Cambia la hora,
          sube el viento y camina entre los cerezos.
        </p>
      </header>

      {/* Botón de panel */}
      <button
        onClick={() => setPanelOpen((v) => !v)}
        className="absolute right-4 top-4 z-20 flex items-center gap-2 rounded-md border border-[#2c3f2e] bg-[#0b130e]/85 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#c9d6c0] backdrop-blur-sm transition-colors hover:border-[#a8d860]/50 hover:text-[#e8efdd] sm:right-6 sm:top-6"
      >
        {IconSliders}
        <span className="hidden sm:inline">{panelOpen ? 'Cerrar' : 'Ajustes'}</span>
      </button>

      {/* Panel de control */}
      <aside
        className={`absolute right-4 top-16 z-10 max-h-[calc(100vh-100px)] w-[248px] origin-top-right overflow-y-auto rounded-lg border border-[#26382a] bg-[#0b130e]/88 p-4 shadow-[0_18px_60px_rgba(0,0,0,0.5)] backdrop-blur-md transition-all duration-300 sm:right-6 sm:top-[68px] ${
          panelOpen
            ? 'pointer-events-auto scale-100 opacity-100'
            : 'pointer-events-none scale-95 opacity-0'
        }`}
      >
        <SectionTitle>Ambiente</SectionTitle>
        <div className="space-y-3">
          <Slider
            label="Hora del día"
            value={params.timeOfDay}
            min={0}
            max={24}
            step={0.1}
            display={fmtTime(params.timeOfDay)}
            onChange={(v) => set('timeOfDay', v)}
          />
          <Slider
            label="Viento"
            value={params.wind}
            min={0}
            max={3}
            step={0.05}
            display={`${(params.wind * 3.4).toFixed(1)} m/s`}
            onChange={(v) => set('wind', v)}
          />
          <Slider
            label="Resplandor"
            value={params.bloom}
            min={0}
            max={1.5}
            step={0.05}
            display={`${Math.round((params.bloom / 1.5) * 100)} %`}
            onChange={(v) => set('bloom', v)}
          />
        </div>

        <SectionTitle>Vegetación</SectionTitle>
        <div className="space-y-3">
          <Slider
            label="Flores"
            value={params.flowerDensity}
            min={0}
            max={1}
            step={0.05}
            display={`${Math.round(params.flowerDensity * 1250)}`}
            onChange={(v) => set('flowerDensity', v)}
          />
          <Slider
            label="Hierba"
            value={params.grassDensity}
            min={0}
            max={1}
            step={0.05}
            display={`${Math.round(params.grassDensity * 9000)}`}
            onChange={(v) => set('grassDensity', v)}
          />
          <button
            onClick={() => engineRef.current?.replant()}
            className="mt-1 flex w-full items-center justify-center gap-2 rounded-md border border-[#a8d860]/35 bg-[#a8d860]/10 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#a8d860] transition-all hover:bg-[#a8d860]/20 active:scale-[0.98]"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-3.5 w-3.5">
              <path d="M20 12a8 8 0 1 1-2.34-5.66" strokeLinecap="round" />
              <path d="M20 3v4h-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Replantar el prado
          </button>
        </div>

        <SectionTitle>Vida</SectionTitle>
        <div className="space-y-1">
          <Toggle label="Luciérnagas" on={params.fireflies} onChange={(v) => set('fireflies', v)} />
          <Toggle label="Pétalos al viento" on={params.petals} onChange={(v) => set('petals', v)} />
          <Toggle label="Mariposas" on={params.butterflies} onChange={(v) => set('butterflies', v)} />
          <Toggle label="Órbita automática" on={params.autoRotate} onChange={(v) => set('autoRotate', v)} />
          <Toggle label="Sonido ambiental" on={params.sound} onChange={(v) => set('sound', v)} />
        </div>
      </aside>

      {/* Telemetría */}
      <footer className="absolute bottom-4 left-4 z-10 sm:bottom-5 sm:left-6">
        <div className="flex flex-wrap items-end gap-x-5 gap-y-2 rounded-md border border-[#1f2f22]/80 bg-[#0b130e]/72 px-4 py-2.5 backdrop-blur-sm">
          <Stat k="FPS" v={stats ? String(stats.fps) : '—'} />
          <Stat k="Hierba" v={stats ? stats.grass.toLocaleString('es') : '—'} />
          <Stat k="Flores" v={stats ? stats.flowers.toLocaleString('es') : '—'} />
          <Stat k="Pétalos" v={stats ? String(stats.petals) : '—'} />
          <Stat k="Viento" v={`${(params.wind * 3.4).toFixed(1)} m/s`} />
          <Stat
            k="Sol"
            v={stats ? `${stats.sunDeg}° · ${stats.phase}` : '—'}
          />
          <Stat k="Hora" v={stats ? stats.timeLabel : '—'} />
        </div>
      </footer>

      {/* Ayuda */}
      <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 hidden -translate-x-1/2 md:block">
        <div className="flex items-center gap-2 rounded-full border border-[#1f2f22]/80 bg-[#0b130e]/72 px-4 py-1.5 text-[11px] text-[#93a88e] backdrop-blur-sm">
          <span>Arrastra para orbitar</span>
          <span className="text-[#3d5540]">·</span>
          <span>Rueda para acercar</span>
          <span className="text-[#3d5540]">·</span>
          <span className="text-[#c9d6c0]">
            Clic en el suelo para <em className="font-display text-[#e6c26a]">plantar una flor</em>
          </span>
        </div>
      </div>

      {/* Pantalla de arranque */}
      {status === 'loading' && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-6 bg-[#070d09]">
          <svg
            className="sprout h-16 w-16 text-[#a8d860]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M12 21v-8" strokeLinecap="round" />
            <path
              d="M12 13c0-4.2 2.6-6.8 7.2-7.3-.4 4.8-3 7.3-7.2 7.3Z"
              strokeLinejoin="round"
            />
            <path
              d="M12 13c0-3.1-2-5.2-5.7-5.6.3 3.9 2.3 5.6 5.7 5.6Z"
              strokeLinejoin="round"
            />
            <path d="M6.5 21h11" strokeLinecap="round" />
          </svg>
          <div className="text-center">
            <div className="font-display text-[26px] italic text-[#f2f6e8]">
              Sembrando el jardín…
            </div>
            <div className="mt-1.5 text-[12px] tracking-wide text-[#93a88e]">
              Terreno, estanque, 9 000 hierbas y cerezos · un par de segundos
            </div>
          </div>
        </div>
      )}

      {/* Pantalla de error con diagnóstico */}
      {status === 'error' && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-[#070d09]/96 p-6">
          <div className="w-full max-w-md rounded-lg border border-[#4a3a28] bg-[#161009] p-6 text-center shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
            <div className="font-display text-[24px] italic text-[#f0d9a8]">
              El jardín no pudo brotar
            </div>
            <p className="mt-3 break-words rounded-md border border-[#3a2f20] bg-[#0d0a06] p-3 font-mono text-[11px] leading-relaxed text-[#d9b98a]">
              {errorMsg || 'Error desconocido al iniciar la escena 3D.'}
            </p>
            <ul className="mx-auto mt-4 max-w-[330px] space-y-1.5 text-left text-[12px] leading-snug text-[#b9a583]">
              <li>· Abre la consola (F12) para ver el detalle completo.</li>
              <li>· Comprueba que la aceleración gráfica esté activada.</li>
              <li>· Sirve la página por HTTP (npm run dev), no como archivo local.</li>
            </ul>
            <button
              onClick={() => {
                setStatus('loading');
                setErrorMsg('');
                setAttempt((a) => a + 1);
              }}
              className="mt-5 rounded-md border border-[#a8d860]/40 bg-[#a8d860]/12 px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-[#a8d860] transition-all hover:bg-[#a8d860]/22 active:scale-[0.97]"
            >
              Reintentar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
