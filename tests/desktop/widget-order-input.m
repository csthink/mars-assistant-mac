// Test-side input helper for the scheduled native tests (mac-feature-t11 V-15, mac-feature-t12 V-15). It posts macOS HID
// mouse and key events through Core Graphics and reports, after every event, where the system cursor is, which
// application is frontmost and which application owns the topmost window under the cursor. It never asks for a
// permission: it reads whether posting events and accessibility are already allowed and refuses otherwise.
// Built by the test with /usr/bin/clang into the disposable test data directory; not part of the product.
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static NSDictionary *State(void) {
  CGEventRef probe = CGEventCreate(NULL);
  CGPoint cursor = CGEventGetLocation(probe);
  CFRelease(probe);
  NSRunningApplication *front = NSWorkspace.sharedWorkspace.frontmostApplication;
  NSString *owner = @"";
  NSNumber *ownerPid = @0, *layer = @0;
  CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
  for (NSDictionary *w in (__bridge NSArray *)windows) {
    CGRect r;
    if (!CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)w[(id)kCGWindowBounds], &r)) continue;
    if ([w[(id)kCGWindowAlpha] doubleValue] <= 0 || !CGRectContainsPoint(r, cursor)) continue;
    owner = w[(id)kCGWindowOwnerName] ?: @"";
    ownerPid = w[(id)kCGWindowOwnerPID] ?: @0;
    layer = w[(id)kCGWindowLayer] ?: @0;
    break;  // The list is ordered front to back.
  }
  if (windows) CFRelease(windows);
  return @{
    @"cursor" : @{@"x" : @(cursor.x), @"y" : @(cursor.y)},
    @"frontmost" : front.localizedName ?: @"",
    @"frontmostPid" : @(front.processIdentifier),
    @"underCursor" : owner,
    @"underCursorPid" : ownerPid,
    @"underCursorLayer" : layer,
  };
}
static void PostButton(CGEventType type, CGPoint p, int clicks, CGMouseButton button) {
  CGEventRef e = CGEventCreateMouseEvent(NULL, type, p, button);
  if (clicks) CGEventSetIntegerValueField(e, kCGMouseEventClickState, clicks);
  CGEventPost(kCGHIDEventTap, e);
  CFRelease(e);
}
static void Post(CGEventType type, CGPoint p, int clicks) { PostButton(type, p, clicks, kCGMouseButtonLeft); }
static void Emit(NSMutableArray *log, NSString *event, CGPoint p) {
  NSMutableDictionary *entry = [State() mutableCopy];
  entry[@"event"] = event;
  entry[@"posted"] = @{@"x" : @(p.x), @"y" : @(p.y)};
  [log addObject:entry];
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSString *command = argc > 1 ? @(argv[1]) : @"";
    NSMutableDictionary *out = [NSMutableDictionary dictionary];
    out[@"postEventAccess"] = @(CGPreflightPostEventAccess());
    out[@"accessibilityTrusted"] = @(AXIsProcessTrusted());
    NSMutableArray *log = [NSMutableArray array];
    if ([command isEqualToString:@"info"]) {
      [out addEntriesFromDictionary:State()];
    } else if (!CGPreflightPostEventAccess() || !AXIsProcessTrusted()) {
      out[@"refused"] = @"posting events is not allowed for this process; nothing posted, nothing requested";
    } else if ([command isEqualToString:@"click"] && argc == 4) {
      CGPoint p = CGPointMake(atof(argv[2]), atof(argv[3]));
      Post(kCGEventMouseMoved, p, 0); Emit(log, @"moved", p); usleep(200000);
      Post(kCGEventLeftMouseDown, p, 1); Emit(log, @"down", p); usleep(80000);
      Post(kCGEventLeftMouseUp, p, 1); Emit(log, @"up", p); usleep(200000);
    } else if ([command isEqualToString:@"drag"] && argc == 7) {
      CGPoint a = CGPointMake(atof(argv[2]), atof(argv[3])), b = CGPointMake(atof(argv[4]), atof(argv[5]));
      int steps = atoi(argv[6]);
      Post(kCGEventMouseMoved, a, 0); Emit(log, @"moved", a); usleep(200000);
      Post(kCGEventLeftMouseDown, a, 1); Emit(log, @"down", a); usleep(300000);
      for (int i = 1; i <= steps; i++) {
        CGPoint p = CGPointMake(a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps);
        Post(kCGEventLeftMouseDragged, p, 1);
        if (i == 1 || i == steps / 2 || i == steps) Emit(log, @"dragged", p);
        usleep(40000);
      }
      usleep(300000);
      Post(kCGEventLeftMouseUp, b, 1); Emit(log, @"up", b); usleep(300000);
    } else if ([command isEqualToString:@"rightclick"] && argc == 4) {
      CGPoint p = CGPointMake(atof(argv[2]), atof(argv[3]));
      Post(kCGEventMouseMoved, p, 0); Emit(log, @"moved", p); usleep(200000);
      PostButton(kCGEventRightMouseDown, p, 1, kCGMouseButtonRight); Emit(log, @"right down", p); usleep(80000);
      PostButton(kCGEventRightMouseUp, p, 1, kCGMouseButtonRight); Emit(log, @"right up", p); usleep(300000);
    } else if ([command isEqualToString:@"windows"] && argc == 3) {
      // Read-only: the on-screen windows of one process, front to back (a sheet is a window of its own).
      pid_t pid = (pid_t)atoi(argv[2]);
      NSMutableArray *list = [NSMutableArray array];
      CFArrayRef windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID);
      for (NSDictionary *w in (__bridge NSArray *)windows)
        if ([w[(id)kCGWindowOwnerPID] intValue] == pid)
          [list addObject:@{@"bounds" : w[(id)kCGWindowBounds] ?: @{}, @"layer" : w[(id)kCGWindowLayer] ?: @0, @"name" : w[(id)kCGWindowName] ?: @""}];
      if (windows) CFRelease(windows);
      out[@"windows"] = list;
    } else if ([command isEqualToString:@"key"] && argc == 3) {
      CGKeyCode code = (CGKeyCode)atoi(argv[2]);
      for (int down = 1; down >= 0; down--) {
        CGEventRef e = CGEventCreateKeyboardEvent(NULL, code, down);
        CGEventPost(kCGHIDEventTap, e);
        CFRelease(e);
        usleep(50000);
      }
      Emit(log, @"key", CGPointZero);
    } else {
      out[@"refused"] = @"usage: info | click x y | rightclick x y | drag x1 y1 x2 y2 steps | key code | windows pid";
    }
    out[@"log"] = log;
    NSData *json = [NSJSONSerialization dataWithJSONObject:out options:0 error:nil];
    fwrite(json.bytes, 1, json.length, stdout);
    return out[@"refused"] ? 2 : 0;
  }
}
