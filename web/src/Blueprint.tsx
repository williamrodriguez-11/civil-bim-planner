import { useEffect, useRef } from "react";

// Axonometría estructural de la portada, independiente de los datos del proyecto.
export function Blueprint() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    function paint() {
      const { width: w, height: h } = canvas.getBoundingClientRect();
      if (!w || !h) return;
      const scale = window.devicePixelRatio || 1;
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext("2d")!;
      ctx.scale(scale, scale);
      const unit = Math.min(w / 8.8, h / 5.5);
      const point = (x: number, y: number, z: number) => [
        w * 0.45 + (x - y) * unit * 0.9,
        h * 0.87 + (x + y) * unit * 0.36 - z * unit * 0.8,
      ];
      const line = (a: number[], b: number[], color: string, width = 1) => {
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      };
      for (let i = -9; i <= 8; i++) {
        line(point(i, -8, 0), point(i, 8, 0), "#446761", 0.4);
        line(point(-8, i, 0), point(8, i, 0), "#446761", 0.4);
      }
      function face(points: number[][], fill: string, stroke: string) {
        ctx.beginPath();
        points.forEach(([x, y], i) =>
          i ? ctx.lineTo(x, y) : ctx.moveTo(x, y),
        );
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 0.9;
        ctx.stroke();
      }
      for (let z = 0; z <= 4; z++) {
        const end = z > 2 ? 1 : 2;
        for (let x = -2; x <= end; x++)
          for (let y = -1; y <= 1; y++) {
            if (z > 0) {
              line(point(x, y, z - 1), point(x, y, z), "#97bcb0", 2.8);
              line(
                point(x + 0.045, y, z - 1),
                point(x + 0.045, y, z),
                "#557e72",
                1,
              );
            }
          }
        const corners = [
          [-2.18, -1.18],
          [end + 0.18, -1.18],
          [end + 0.18, 1.18],
          [-2.18, 1.18],
        ];
        face(
          corners.map(([x, y]) => point(x, y, z)),
          "#2e5149",
          "#a0c4b4",
        );
        for (let i = 1; i < 3; i++) {
          const a = corners[i],
            b = corners[(i + 1) % 4];
          face(
            [
              point(a[0], a[1], z),
              point(b[0], b[1], z),
              point(b[0], b[1], z - 0.09),
              point(a[0], a[1], z - 0.09),
            ],
            "#547a6b",
            "#a1bcab",
          );
        }
        for (let x = -2; x <= end; x++)
          line(point(x, -1.1, z), point(x, 1.1, z), "#79968a", 0.55);
        for (let y = -1; y <= 1; y++)
          line(point(-2.1, y, z), point(end + 0.1, y, z), "#79968a", 0.55);
      }
      ctx.setLineDash([3, 4]);
      line(point(-2.4, 1.5, 0), point(-2.4, 1.5, 4.5), "#c8d291", 0.8);
      ctx.setLineDash([]);
    }
    const observer = new ResizeObserver(paint);
    observer.observe(canvas);
    paint();
    return () => observer.disconnect();
  }, []);
  return (
    <canvas
      ref={ref}
      className="blueprint"
      aria-label="Ilustración axonométrica de una estructura aporticada"
    />
  );
}
