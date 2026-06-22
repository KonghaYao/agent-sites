// 端口分配器单测，迁移自 crates/server/src/process/port_allocator_test.rs
// 被测: src/process/port_allocator.ts PortAllocator
// 说明: 纯函数测试,无 spawn/PocketBase/tempfile,无需 TEST_SPAWN_LOCK 或 pbBinaryAvailable skip
import { assertEquals } from "jsr:@std/assert@^1";
import { PortAllocator } from "./port_allocator.ts";

Deno.test("test_分配首个端口_从最小值开始", () => {
  const allocator = new PortAllocator(9000, 9100);
  const port = allocator.allocate(new Set<number>());
  assertEquals(port, 9000);
});

Deno.test("test_跳过已用端口", () => {
  const allocator = new PortAllocator(9000, 9100);
  const used = new Set<number>([9000, 9001, 9002]);
  const port = allocator.allocate(used);
  assertEquals(port, 9003);
});

Deno.test("test_全范围耗尽_返回零表示失败", () => {
  const allocator = new PortAllocator(9000, 9002);
  const used = new Set<number>([9000, 9001, 9002]);
  const port = allocator.allocate(used);
  assertEquals(port, 0, "全部端口被占用应返回 0");
});

Deno.test("test_范围中间有空洞_选最小", () => {
  const allocator = new PortAllocator(9000, 9100);
  const used = new Set<number>([9000, 9005]);
  const port = allocator.allocate(used);
  assertEquals(port, 9001);
});

Deno.test("test_min_max_相同_单端口", () => {
  const allocator = new PortAllocator(9005, 9005);
  assertEquals(allocator.allocate(new Set<number>()), 9005);
  const used = new Set<number>([9005]);
  assertEquals(allocator.allocate(used), 0);
});

Deno.test("test_min_大于_max_始终返回零", () => {
  const allocator = new PortAllocator(9100, 9000);
  const port = allocator.allocate(new Set<number>());
  assertEquals(port, 0);
});
