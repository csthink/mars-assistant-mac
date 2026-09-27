// Mouse-down observation only. No keyboard events, event suppression or event posting.
#import <AppKit/AppKit.h>
#include <node_api.h>

struct Subscription {
  napi_threadsafe_function callback = nullptr;
  id global = nil;
  id local = nil;
  bool active = true;
};
struct PanelMousePoint { double x; double y; };
static Subscription* current = nullptr;

static void StopMonitor() {
  Subscription* sub = current;
  if (!sub) return;
  current = nullptr;
  sub->active = false;
  if (sub->global) [NSEvent removeMonitor:sub->global];
  if (sub->local) [NSEvent removeMonitor:sub->local];
  sub->global = nil;
  sub->local = nil;
  napi_release_threadsafe_function(sub->callback, napi_tsfn_abort);
}
static void Deliver(napi_env env, napi_value callback, void* context, void* data) {
  PanelMousePoint* point = static_cast<PanelMousePoint*>(data);
  Subscription* sub = static_cast<Subscription*>(context);
  if (env && callback && sub->active) {
    napi_value value, x, y, receiver;
    napi_create_object(env, &value);
    napi_create_double(env, point->x, &x);
    napi_create_double(env, point->y, &y);
    napi_set_named_property(env, value, "x", x);
    napi_set_named_property(env, value, "y", y);
    napi_get_undefined(env, &receiver);
    napi_call_function(env, receiver, callback, 1, &value, nullptr);
  }
  delete point;
}
static void Observe(Subscription* sub) {
  if (!sub->active) return;
  // Cocoa uses points with bottom-left origin. Electron uses points with
  // top-left origin on the primary display, including negative monitor offsets.
  NSPoint p = [NSEvent mouseLocation];
  NSScreen* primary = [[NSScreen screens] firstObject];
  if (!primary) return;
  PanelMousePoint* point = new PanelMousePoint{p.x, NSMaxY(primary.frame) - p.y};
  if (napi_call_threadsafe_function(sub->callback, point, napi_tsfn_nonblocking) != napi_ok)
    delete point;
}
static napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value callback, name;
  napi_get_cb_info(env, info, &argc, &callback, nullptr, nullptr);
  napi_valuetype type;
  if (argc != 1 || napi_typeof(env, callback, &type) != napi_ok || type != napi_function) {
    napi_throw_type_error(env, nullptr, "Expected a mouse callback");
    return nullptr;
  }
  if (![NSThread isMainThread] || !NSApp) {
    napi_throw_error(env, nullptr, "Mouse monitor requires the Electron main application");
    return nullptr;
  }
  StopMonitor();
  Subscription* sub = new Subscription;
  napi_create_string_utf8(env, "panel-outside-click", NAPI_AUTO_LENGTH, &name);
  napi_status status = napi_create_threadsafe_function(env, callback, nullptr, name,
    0, 1, sub, [](napi_env, void* data, void*) { delete static_cast<Subscription*>(data); },
    sub, Deliver, &sub->callback);
  if (status != napi_ok) {
    delete sub;
    napi_throw_error(env, nullptr, "Cannot create mouse callback");
    return nullptr;
  }
  current = sub;
  napi_unref_threadsafe_function(env, sub->callback);
  NSEventMask mask = NSEventMaskLeftMouseDown | NSEventMaskRightMouseDown | NSEventMaskOtherMouseDown;
  sub->global = [NSEvent addGlobalMonitorForEventsMatchingMask:mask handler:^(NSEvent*) {
    Observe(sub);
  }];
  sub->local = [NSEvent addLocalMonitorForEventsMatchingMask:mask handler:^NSEvent*(NSEvent* event) {
    Observe(sub);
    return event;
  }];
  if (!sub->global || !sub->local) {
    StopMonitor();
    napi_throw_error(env, nullptr, "Cannot observe outside mouse clicks");
    return nullptr;
  }
  return nullptr;
}
static napi_value Stop(napi_env, napi_callback_info) { StopMonitor(); return nullptr; }
static napi_value IsActive(napi_env env, napi_callback_info) {
  napi_value result;
  napi_get_boolean(env, current != nullptr, &result);
  return result;
}
static napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"stop", nullptr, Stop, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"isActive", nullptr, IsActive, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 3, properties);
  napi_add_env_cleanup_hook(env, [](void*) { StopMonitor(); }, nullptr);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
