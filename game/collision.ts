/** Collision math in the arena's X/Z plane. Fractions are along [from, to]. */
interface Point { x: number; z: number }
export interface CollisionObstacle extends Point { hx: number; hz: number; radius?: number }
const AXES = ["x", "z"] as const;

export function segmentCircleHit(from: Point, to: Point, center: Point, radius: number): number | null {
  const x = from.x - center.x;
  const z = from.z - center.z;
  const c = x * x + z * z - radius * radius;
  if (c <= 0) return 0;
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const a = dx * dx + dz * dz;
  if (a === 0) return null;
  const b = x * dx + z * dz;
  const discriminant = b * b - a * c;
  if (discriminant < 0) return null;
  const t = (-b - Math.sqrt(discriminant)) / a;
  return t >= 0 && t <= 1 ? t : null;
}

export function segmentObstacleHit(from: Point, to: Point, obstacle: CollisionObstacle): number | null {
  if (obstacle.radius) return segmentCircleHit(from, to, obstacle, obstacle.radius);
  let entry = 0;
  let exit = 1;
  for (const axis of AXES) {
    const half = axis === "x" ? obstacle.hx : obstacle.hz;
    const start = from[axis] - obstacle[axis];
    const delta = to[axis] - from[axis];
    if (delta === 0) {
      if (Math.abs(start) > half) return null;
      continue;
    }
    const a = (-half - start) / delta;
    const b = (half - start) / delta;
    entry = Math.max(entry, Math.min(a, b));
    exit = Math.min(exit, Math.max(a, b));
    if (entry > exit) return null;
  }
  return entry;
}

/** Push a circle out of cover, including when its centre is inside the cover. */
export function resolveCircleObstacle(position: Point, radius: number, obstacle: CollisionObstacle, velocity?: Point) {
  let nx: number;
  let nz: number;
  let penetration: number;
  if (obstacle.radius) {
    const dx = position.x - obstacle.x;
    const dz = position.z - obstacle.z;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq >= (radius + obstacle.radius) ** 2) return;
    const distance = Math.sqrt(distanceSq);
    penetration = radius + obstacle.radius - distance;
    nx = distance > 0 ? dx / distance : 1;
    nz = distance > 0 ? dz / distance : 0;
  } else {
    const closestX = Math.max(obstacle.x - obstacle.hx, Math.min(obstacle.x + obstacle.hx, position.x));
    const closestZ = Math.max(obstacle.z - obstacle.hz, Math.min(obstacle.z + obstacle.hz, position.z));
    const dx = position.x - closestX;
    const dz = position.z - closestZ;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq >= radius * radius) return;
    const distance = Math.sqrt(distanceSq);
    if (distance > 0) {
      nx = dx / distance;
      nz = dz / distance;
      penetration = radius - distance;
    } else {
      const exitX = obstacle.hx - Math.abs(position.x - obstacle.x);
      const exitZ = obstacle.hz - Math.abs(position.z - obstacle.z);
      const alongX = exitX <= exitZ;
      nx = alongX ? (position.x >= obstacle.x ? 1 : -1) : 0;
      nz = alongX ? 0 : (position.z >= obstacle.z ? 1 : -1);
      penetration = radius + (alongX ? exitX : exitZ);
    }
  }
  position.x += nx * penetration;
  position.z += nz * penetration;
  if (velocity) {
    const intoWall = velocity.x * nx + velocity.z * nz;
    if (intoWall < 0) {
      velocity.x -= intoWall * nx;
      velocity.z -= intoWall * nz;
    }
  }
}
