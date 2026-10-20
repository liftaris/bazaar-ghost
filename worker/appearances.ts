import { decodeRow, integer, requireValue, rows, uuid } from './http';
import { recordingUrls, source } from './platform-registry';

type Input=Record<string,any>;
const withUrls=<T extends Record<string,any>>(row:T):T&ReturnType<typeof recordingUrls>=>({...row,...recordingUrls(row)});
function filters(input:Input) {
  const clauses:string[]=[],args:unknown[]=[];
  if(input.search_query!=null) {
    requireValue(typeof input.search_query==='string'&&input.search_query.length<=128,'Invalid search');
    if(input.search_query) {clauses.push("username LIKE ? ESCAPE '\\'");args.push('%'+input.search_query.replace(/[\\%_]/g,(c:string)=>'\\'+c)+'%');}
  }
  if(input.source_filter!=null) {clauses.push('source=?');args.push(source(input.source_filter));}
  if(input.account_filter!=null) {clauses.push('platform_account_id=?');args.push(uuid(input.account_filter));}
  if(input.video_filter!=null) {clauses.push('vod_id=?');args.push(integer(input.video_filter,'video filter',1));}
  return {where:clauses.length?'WHERE '+clauses.join(' AND '):'',args,
    limit:integer(input.result_limit??100,'result_limit',1,500),offset:integer(input.result_offset??0,'result_offset',0,100000)};
}
export async function videoSearch(env:Env,input:Input) {
  const {where,args,limit,offset}=filters(input);
  return (await rows(env,`SELECT * FROM video_detections ${where} ORDER BY indexed_at DESC,detection_id LIMIT ? OFFSET ?`,...args,limit,offset)).map(decodeRow).map(withUrls);
}
export async function appearanceSearch(env:Env,input:Input) {
  const {where,args,limit,offset}=filters(input);
  const visible=`WITH visible AS (SELECT coalesce(a.matchup_id,d.detection_id) AS group_id,d.* FROM video_detections d LEFT JOIN matchup_anchors c ON c.current_detection_id=d.detection_id LEFT JOIN (SELECT x.id AS clip_id,CAST(x.matchup_id AS TEXT) AS matchup_id FROM matchup_anchors x WHERE EXISTS(SELECT 1 FROM matchup_anchors y WHERE y.matchup_id=x.matchup_id AND y.id!=x.id)) a ON a.clip_id=c.id)`;
  // Select matched groups before pagination, then include all available copies of each matched group.
  const fields = [
    'detection_id','username','confidence','rank','frame_time_seconds','storage_path',
    'no_right_edge','truncated','igd','indexed_at','vod_id','source','source_id',
    'source_video_id','source_part_id','source_part_index','title','published_at',
    'recorded_at','platform_account_id','streamer_id','creator_name','recorded_timestamp',
  ];
  const jsonObject = fields.map(field => `'${field}',${field}`).join(',');
  // One SQL statement provides one snapshot for group selection and all of its copies.
  const groups=await rows(env,`${visible}, matched AS(SELECT DISTINCT group_id FROM visible ${where}),
    selected AS (SELECT v.group_id,max(v.indexed_at) AS latest,count(*) OVER() AS total_count
      FROM visible v JOIN matched m USING(group_id) GROUP BY v.group_id
      ORDER BY latest DESC,v.group_id LIMIT ? OFFSET ?)
    SELECT selected.group_id,selected.total_count,
      (SELECT json_group_array(json_object(${jsonObject})) FROM
        (SELECT * FROM visible WHERE group_id=selected.group_id ORDER BY confidence DESC,detection_id)) AS copies
    FROM selected ORDER BY selected.latest DESC,selected.group_id`,...args,limit,offset);
  return groups.map(group=>{
    const appearances = (JSON.parse(group.copies) as Record<string,unknown>[]).map(decodeRow).map(withUrls);
    return {matchup_id:group.group_id,username:appearances[0].username,appearances,total_count:group.total_count};
  });
}
