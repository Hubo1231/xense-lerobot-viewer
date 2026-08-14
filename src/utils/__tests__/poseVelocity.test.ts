import { describe, expect, test } from "bun:test";
import { buildPoseVelocityChartGroups } from "@/utils/poseVelocity";

const identityRotation = [1, 0, 0, 0, 1, 0];
const positiveNinetyDegreesAroundZ = [0, 1, 0, -1, 0, 0];
const positiveNinetyDegreesAroundY = [0, 0, -1, 0, 1, 0];
const yNinetyThenLocalXNinety = [0, 0, -1, 1, 0, 0];

function poseRow(
  timestamp: number,
  position: [number, number, number],
  rotation: number[],
) {
  return {
    timestamp,
    "action | left_tcp.x": position[0],
    "action | left_tcp.y": position[1],
    "action | left_tcp.z": position[2],
    "action | left_tcp.r1": rotation[0],
    "action | left_tcp.r2": rotation[1],
    "action | left_tcp.r3": rotation[2],
    "action | left_tcp.r4": rotation[3],
    "action | left_tcp.r5": rotation[4],
    "action | left_tcp.r6": rotation[5],
  };
}

describe("buildPoseVelocityChartGroups", () => {
  test("derives linear velocity from source timestamps before display sampling", () => {
    const groups = buildPoseVelocityChartGroups(
      [
        poseRow(0, [0, 0, 0], identityRotation),
        poseRow(10, [1, -0.5, 0.25], identityRotation),
      ],
      { sourceTimestamps: [20, 20.5], fps: 30 },
    );

    const linearX = groups[0][1]["left_tcp.vx (m/s)"] as Record<string, number>;
    const linearY = groups[0][1]["left_tcp.vy (m/s)"] as Record<string, number>;
    const linearZ = groups[0][1]["left_tcp.vz (m/s)"] as Record<string, number>;
    expect(linearX.action).toBeCloseTo(2, 8);
    expect(linearY.action).toBeCloseTo(-1, 8);
    expect(linearZ.action).toBeCloseTo(0.5, 8);
    expect(groups[0][1].timestamp).toBe(10);
  });

  test("derives world-frame xyz angular velocity without converting to RPY", () => {
    const groups = buildPoseVelocityChartGroups(
      [
        poseRow(0, [0, 0, 0], identityRotation),
        poseRow(0.5, [0, 0, 0], positiveNinetyDegreesAroundZ),
      ],
      { fps: 30 },
    );

    const angularX = groups[1][1]["left_tcp.ωx (deg/s, world frame)"] as Record<
      string,
      number
    >;
    const angularY = groups[1][1]["left_tcp.ωy (deg/s, world frame)"] as Record<
      string,
      number
    >;
    const angularZ = groups[1][1]["left_tcp.ωz (deg/s, world frame)"] as Record<
      string,
      number
    >;
    expect(angularX.action).toBeCloseTo(0, 8);
    expect(angularY.action).toBeCloseTo(0, 8);
    expect(angularZ.action).toBeCloseTo(180, 8);
  });

  test("expresses directional angular velocity in the world frame", () => {
    const groups = buildPoseVelocityChartGroups(
      [
        poseRow(0, [0, 0, 0], positiveNinetyDegreesAroundY),
        poseRow(0.5, [0, 0, 0], yNinetyThenLocalXNinety),
      ],
      { fps: 30 },
    );

    const angularX = groups[1][1]["left_tcp.ωx (deg/s, world frame)"] as Record<
      string,
      number
    >;
    const angularY = groups[1][1]["left_tcp.ωy (deg/s, world frame)"] as Record<
      string,
      number
    >;
    const angularZ = groups[1][1]["left_tcp.ωz (deg/s, world frame)"] as Record<
      string,
      number
    >;
    expect(angularX.action).toBeCloseTo(0, 8);
    expect(angularY.action).toBeCloseTo(0, 8);
    expect(angularZ.action).toBeCloseTo(-180, 8);
  });

  test("omits angular velocity when a complete r1-r6 group is unavailable", () => {
    const row = poseRow(0, [0, 0, 0], identityRotation);
    delete (row as Partial<typeof row>)["action | left_tcp.r6"];
    const groups = buildPoseVelocityChartGroups([row], { fps: 30 });

    expect(groups).toHaveLength(1);
    expect(Object.keys(groups[0][0]).some((key) => key.includes("ω"))).toBe(
      false,
    );
  });

  test("derives action and state gripper velocity from gripper position", () => {
    const groups = buildPoseVelocityChartGroups(
      [
        {
          timestamp: 0,
          "action | left_gripper.pos": 0.2,
          "observation.state | left_gripper.pos": 0.1,
        },
        {
          timestamp: 10,
          "action | left_gripper.pos": 0.3,
          "observation.state | left_gripper.pos": 0.05,
        },
      ],
      { sourceTimestamps: [20, 20.5], fps: 30 },
    );

    const velocity = groups[0][1]["left_gripper.velocity (unit/s)"] as Record<
      string,
      number
    >;
    expect(velocity.action).toBeCloseTo(0.2, 8);
    expect(velocity["observation.state"]).toBeCloseTo(-0.1, 8);
  });
});
