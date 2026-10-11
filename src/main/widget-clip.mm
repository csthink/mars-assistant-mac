// A macOS hit-testing boundary for a complete WebContentsView viewport.
// Pixel clipping belongs to the Electron compositor View hierarchy.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>
#include <cmath>
#include <set>
#include <cstring>

@interface WidgetClipView : NSView
@property BOOL flippedCoordinates;
@end
@implementation WidgetClipView
- (BOOL)isFlipped { return self.flippedCoordinates; }
- (NSView*)hitTest:(NSPoint)point {
  if (!NSPointInRect(point, self.frame)) return nil;
  return [super hitTest:point];
}
@end

struct ClipBinding {
  __weak NSView* root = nil;
  __weak NSView* child = nil;
  __strong NSArray<NSView*>* before = nil;
  __strong WidgetClipView* clip = nil;
  bool disposed = false;
};
static std::set<ClipBinding*> bindings;

static void Dispose(ClipBinding* binding) {
  if (binding->disposed) return;
  binding->disposed = true;
  NSView* child = binding->child;
  NSView* root = binding->root;
  // Removal must not make a retired view visible again during its close sequence.
  if (child && child.superview == binding->clip) {
    child.hidden = YES;
    if (root && root.window) [root addSubview:child];
    else [child removeFromSuperview];
  }
  [binding->clip removeFromSuperview];
  binding->clip = nil;
  binding->before = nil;
}
static bool MainThread(napi_env env) {
  if ([NSThread isMainThread] && NSApp) return true;
  napi_throw_error(env, nullptr, "Widget clipping requires the main application thread");
  return false;
}
static ClipBinding* Binding(napi_env env, napi_value value) {
  void* data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok ||
      !bindings.count(static_cast<ClipBinding*>(data))) {
    napi_throw_type_error(env, nullptr, "Expected a widget clipping binding");
    return nullptr;
  }
  return static_cast<ClipBinding*>(data);
}
static NSView* Root(napi_env env, napi_value value) {
  void* data = nullptr;
  size_t length = 0;
  if (napi_get_buffer_info(env, value, &data, &length) != napi_ok || length != sizeof(void*)) {
    napi_throw_type_error(env, nullptr, "Expected a native window handle");
    return nil;
  }
  void* address = nullptr;
  std::memcpy(&address, data, sizeof(address));
  // Compare addresses before dereferencing: only this process's live window roots qualify.
  for (NSWindow* window in NSApp.windows)
    if ((__bridge void*)window.contentView == address) return window.contentView;
  napi_throw_error(env, nullptr, "Widget clipping owner is unavailable");
  return nil;
}
static napi_value Begin(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  size_t argc = 1;
  napi_value handle;
  napi_get_cb_info(env, info, &argc, &handle, nullptr, nullptr);
  NSView* root = argc == 1 ? Root(env, handle) : nil;
  if (!root) return nullptr;
  ClipBinding* binding = new ClipBinding;
  binding->root = root;
  binding->before = [root.subviews copy];
  bindings.insert(binding);
  napi_value result;
  napi_create_external(env, binding, [](napi_env, void* data, void*) {
    ClipBinding* binding = static_cast<ClipBinding*>(data);
    Dispose(binding);
    bindings.erase(binding);
    delete binding;
  }, nullptr, &result);
  return result;
}
static napi_value Finish(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  ClipBinding* binding = argc == 1 ? Binding(env, arg) : nullptr;
  if (!binding) return nullptr;
  NSView* root = binding->root;
  if (binding->disposed || binding->clip || !root.window || !binding->before) {
    napi_throw_error(env, nullptr, "Widget clipping attachment is no longer valid");
    return nullptr;
  }
  NSMutableArray<NSView*>* added = [NSMutableArray array];
  for (NSView* child in root.subviews)
    if (![binding->before containsObject:child]) [added addObject:child];
  if (added.count != 1) {
    Dispose(binding);
    napi_throw_error(env, nullptr, "Cannot identify exactly one new widget native view");
    return nullptr;
  }
  NSView* child = added.firstObject;
  // Attachment is synchronous, before loading or revealing the generated document.
  NSResponder* responder = root.window.firstResponder;
  WidgetClipView* clip = [[WidgetClipView alloc] initWithFrame:NSZeroRect];
  clip.flippedCoordinates = root.isFlipped;
  clip.wantsLayer = YES;
  clip.layer.masksToBounds = YES;
  clip.clipsToBounds = YES;
  clip.hidden = YES;
  [root addSubview:clip positioned:NSWindowAbove relativeTo:child];
  [clip addSubview:child];
  binding->child = child;
  binding->clip = clip;
  binding->before = nil;
  if (responder && root.window.firstResponder != responder)
    [root.window makeFirstResponder:responder];
  return nullptr;
}
static bool Rectangle(napi_env env, napi_value value, NSRect* rect, bool full = false) {
  double numbers[4];
  const char* keys[] = {"x", "y", "width", "height"};
  for (int i = 0; i < 4; ++i) {
    napi_value part;
    if (napi_get_named_property(env, value, keys[i], &part) != napi_ok ||
        napi_get_value_double(env, part, &numbers[i]) != napi_ok || !std::isfinite(numbers[i])) return false;
  }
  if ((!full && (numbers[0] < 0 || numbers[1] < 0)) || numbers[2] < (full ? 1 : 0) || numbers[3] < (full ? 1 : 0) ||
      numbers[2] > 8192 || numbers[3] > 4096) return false;
  *rect = NSMakeRect(numbers[0], numbers[1], numbers[2], numbers[3]);
  return true;
}
static napi_value Place(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  size_t argc = 4;
  napi_value args[4];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 3 && argc != 4) { napi_throw_type_error(env, nullptr, "Expected clipping binding, rectangle, visibility and optional full layout"); return nullptr; }
  ClipBinding* binding = Binding(env, args[0]);
  if (!binding) return nullptr;
  NSRect rect, full;
  bool visible = false;
  NSView* root = binding->root;
  NSView* child = binding->child;
  WidgetClipView* clip = binding->clip;
  if (binding->disposed || !root.window || !child || !clip ||
      clip.superview != root || child.superview != clip || child.window != root.window ||
      !Rectangle(env, args[1], &rect) || (argc == 4 && !Rectangle(env, args[3], &full, true)) || napi_get_value_bool(env, args[2], &visible) != napi_ok) {
    clip.hidden = YES;
    child.hidden = YES;
    napi_throw_error(env, nullptr, "Widget native clipping boundary is unavailable");
    return nullptr;
  }
  NSRect rootBounds = root.bounds;
  if (!root.isFlipped) rect.origin.y = NSMaxY(rootBounds) - NSMaxY(rect);
  rect = NSIntersectionRect(rootBounds, rect);
  // Chromium continues assigning window-root coordinates to the child. Matching frame
  // and bounds keeps that coordinate space intact, including after resize and scroll.
  [CATransaction begin];
  [CATransaction setDisableActions:YES];
  // NativeViewHost skips ShowWidget when its visible bounds are empty. Commit the
  // complete document size here as well, while both drawing and input remain hidden.
  // AppKit propagates this frame through the existing WebContents autoresizing chain.
  if (argc == 4) {
    if (!root.isFlipped) full.origin.y = NSMaxY(rootBounds) - NSMaxY(full);
    if (!NSEqualRects(child.frame, full)) child.frame = full;
  }
  clip.frame = rect;
  clip.bounds = rect;
  clip.hidden = !visible || NSIsEmptyRect(rect);
  [CATransaction commit];
  return nullptr;
}
static napi_value Release(napi_env env, napi_callback_info info) {
  if (!MainThread(env)) return nullptr;
  size_t argc = 1;
  napi_value arg;
  napi_get_cb_info(env, info, &argc, &arg, nullptr, nullptr);
  ClipBinding* binding = argc == 1 ? Binding(env, arg) : nullptr;
  if (binding) Dispose(binding);
  return nullptr;
}
static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"beginAttach", nullptr, Begin, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"finishAttach", nullptr, Finish, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"place", nullptr, Place, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"dispose", nullptr, Release, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 4, properties);
  napi_add_env_cleanup_hook(env, [](void*) { for (ClipBinding* binding : bindings) Dispose(binding); }, nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
