// Read-only AppKit assertions for the isolated background integration client.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <node_api.h>
static NSDictionary* RectValue(NSRect r) { return @{@"x":@(r.origin.x),@"y":@(r.origin.y),@"width":@(r.size.width),@"height":@(r.size.height)}; }
static napi_value Inspect(napi_env env,napi_callback_info info) {
 size_t argc=1;napi_value arg;napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);
 void* data=nullptr;size_t size=0;if(argc!=1||napi_get_buffer_info(env,arg,&data,&size)!=napi_ok||size!=sizeof(void*)){napi_throw_type_error(env,nullptr,"Expected live window handle");return nullptr;}
 NSView* root=(__bridge NSView*)(*static_cast<void**>(data));root=root.window.contentView;
 NSMutableArray* clips=[NSMutableArray array];
 for(NSView* clip in root.subviews) {
  if(![NSStringFromClass(clip.class) isEqualToString:@"WidgetClipView"])continue;
  NSRect r=clip.frame;NSPoint inside=NSMakePoint(NSMidX(r),NSMidY(r));NSPoint above=NSMakePoint(NSMidX(r),NSMaxY(r)+4);
  NSView* insideHit=[root hitTest:inside];NSView* aboveHit=[root hitTest:above];
  NSMutableArray* children=[NSMutableArray array];for(NSView* c in clip.subviews)[children addObject:RectValue(c.frame)];
  [clips addObject:@{@"frame":RectValue(clip.frame),@"bounds":RectValue(clip.bounds),@"clips":@(clip.clipsToBounds),@"mask":@(clip.layer.masksToBounds),@"hidden":@(clip.hidden),@"children":children,@"insideHitsWidget":@([insideHit isDescendantOf:clip]),@"aboveHitsWidget":@([aboveHit isDescendantOf:clip])}];
 }
 NSData* json=[NSJSONSerialization dataWithJSONObject:@{@"clips":clips,@"rootHeight":@(root.bounds.size.height)} options:0 error:nil];
 napi_value result;napi_create_string_utf8(env,static_cast<const char*>(json.bytes),json.length,&result);return result;
}
static napi_value Detach(napi_env env,napi_callback_info info) {
 size_t argc=1;napi_value arg;napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);void* data=nullptr;size_t size=0;
 if(argc!=1||napi_get_buffer_info(env,arg,&data,&size)!=napi_ok||size!=sizeof(void*)){napi_throw_type_error(env,nullptr,"Expected live window handle");return nullptr;}
 NSView* root=(__bridge NSView*)(*static_cast<void**>(data));root=root.window.contentView;
 for(NSView* clip in [root.subviews copy])if([NSStringFromClass(clip.class) isEqualToString:@"WidgetClipView"] && clip.subviews.count){[root addSubview:clip.subviews.firstObject];break;}
 return nullptr;
}
static napi_value Init(napi_env env,napi_value exports) {napi_property_descriptor p[]={
{"inspect",nullptr,Inspect,nullptr,nullptr,nullptr,napi_default,nullptr},
{"detach",nullptr,Detach,nullptr,nullptr,nullptr,napi_default,nullptr}};napi_define_properties(env,exports,2,p);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,Init)
