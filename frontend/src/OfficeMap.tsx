import { useEffect, useRef, useState } from "react";
import Phaser from "phaser";
import { OfficeScene } from "./OfficeScene";
import type { Staff, StaffId } from "./simulation";

export default function OfficeMap({
  staff,
  onSelect,
}: {
  staff: Staff[];
  onSelect: (id: StaffId) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const game = useRef<Phaser.Game | null>(null);
  const latest = useRef(staff);
  const callback = useRef(onSelect);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    callback.current = onSelect;
  }, [onSelect]);
  useEffect(() => {
    latest.current = staff;
    game.current?.events.emit("office:state", staff);
  }, [staff]);
  useEffect(() => {
    if (!container.current) return;
    const host = container.current;
    // Account forms can move the canvas without resizing it. Phaser caches
    // page coordinates, so refresh them before mouse/touch input is processed.
    const updateBounds = () => {
      if (game.current?.scale?.canvas) game.current.scale.updateBounds();
    };
    const observer = new ResizeObserver(updateBounds);
    try {
      game.current = new Phaser.Game({
        type: Phaser.CANVAS,
        parent: container.current,
        width: 960,
        height: 664,
        pixelArt: true,
        antialias: false,
        banner: false,
        scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
        scene: new OfficeScene(latest.current, (id) => callback.current(id)),
        audio: { noAudio: true },
        fps: { target: 30, forceSetTimeOut: true },
      });
      observer.observe(document.body);
      host.addEventListener("mousedown", updateBounds, true);
      host.addEventListener("mousemove", updateBounds, true);
      host.addEventListener("touchstart", updateBounds, {
        capture: true,
        passive: true,
      });
      window.addEventListener("scroll", updateBounds, true);
    } catch {
      setFailed(true);
    }
    return () => {
      observer.disconnect();
      host.removeEventListener("mousedown", updateBounds, true);
      host.removeEventListener("mousemove", updateBounds, true);
      host.removeEventListener("touchstart", updateBounds, true);
      window.removeEventListener("scroll", updateBounds, true);
      game.current?.destroy(true);
      game.current = null;
    };
  }, []);
  return (
    <div
      className="map-container"
      ref={container}
      role="img"
      aria-label="탑다운 픽셀아트 사무실. 직원 6명과 업무 구역 8곳. 직원 정보는 아래 직원 버튼으로도 확인할 수 있습니다."
    >
      {failed && (
        <p role="alert">
          사무실 화면을 열지 못했습니다. 브라우저를 새로고침해 주세요. 직원
          정보와 업무 시연은 아래에서 이용할 수 있습니다.
        </p>
      )}
    </div>
  );
}
