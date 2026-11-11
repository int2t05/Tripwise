# 旅行渠道与 MCP 扩展清单

| 项 | 内容 |
|---|---|
| 更新日期 | 2026-11-11 |
| 用途 | 按个人旅行规划场景整理可接入的数据渠道、MCP 项目、凭证和接入顺序，作为后续配置与人工审阅清单。 |
| 范围 | 旅行研究、地点/路线、天气、航班信息和公开攻略；不预订或购买行程服务、不发布社交内容。可计费的数据调用须显示费用并限制单次额度。 |
| 完整性 | 这是按 Tripwise 需求筛选的候选目录，不是 MCP 生态的穷尽清单。候选能力和认证方式会随服务商变更，接入前须重新核验。 |

## 首批服务配置

需要真实联测时，在 Tripwise「连接与隐私」中填写密钥并使用各自的连接测试。不要把密钥发到聊天、源码、文档或旅行备份。

| 服务 | 需要配置 | 目前能力 |
|---|---|---|
| OpenAI-compatible 模型 | 服务地址、模型名、API Key | 对话规划与行程工具调用；支持兼容 Chat Completions 的服务。 |
| Exa | Exa API Key | 通用旅行资料搜索；适合补充语义相关和长尾网页。 |
| Tavily | Tavily API Key | 开放时间、预约、票价、班次等时效事实搜索；与 Exa 交叉补充。 |
| Firecrawl | Firecrawl API Key | 抽取本次旅行已搜索或导入的公开网页正文，供关键事实核对；不做整站抓取。 |
| 高德地图 | Web 服务 Key、Web JS API Key、JS API 安全密钥 | 地点、地图底图与路线。正式开放前仍需高德书面确认服务数据用途和留存范围，见 [ADR-0010](../design/adr/0010-map-provider-compatibility.md)。 |

DuckDuckGo 基础搜索与 Open-Meteo 天气无需 Key。

实现状态和最近一次真实服务结果集中记录在[项目进度](../PROJECT-STATUS.md)与[北京评测](../evaluation/TRAVEL-CASES.md)，本目录只维护渠道能力、接入顺序和安全边界。

## 推荐结论

- Exa、Tavily、Firecrawl 使用内置 API 连接器，统一来源、回退和网页读取限制；不重复开放相同服务的 MCP 工具。
- 地图采用高德产品族；精确通勤仅使用可绑定起终点和来源的结构化路线工具。当前验收状态见[项目进度](../PROJECT-STATUS.md)。
- 网页研究使用右侧隔离浏览器；它是 Tripwise 内置工具，不是独立 Browser MCP Server。其他来源按需通过本机或远程 MCP 扩展，并逐项批准工具。

## public-apis 候选核对

[public-apis](https://github.com/public-apis/public-apis/tree/88706670ac0ffaad7bf3c6307747e2515f638bed) 是发现目录，不是运行时服务或质量认证。2026-11-11 核对时，`master` 仍指向该快照。README 由社区维护，也推广 APILayer；认证、HTTPS、CORS 和 MCP transport 字段不覆盖配额、许可、数据覆盖或服务等级，接入前仍要以服务商文档为准。Tripwise 已支持远程 MCP，可按目的地接入，不必为目录里的每个 API 写内置连接器。

2026-11-11 复查天气、地图、交通、旅行、社交和 MCP Servers 分类；`master` 仍指向 [88706670](https://github.com/public-apis/public-apis/tree/88706670ac0ffaad7bf3c6307747e2515f638bed)。它是发现目录，现有覆盖里有不少地区公交 API；没有一个适合作为全球通用公交路线源。确认一项直接对应旅行攻略的候选：[SocialCrawl 官方 MCP](https://github.com/socialcrawl/mcp) 支持远程 Streamable HTTP 与 stdio；其 README 列出小红书笔记搜索、详情、用户笔记和评论，并称部分读取按返回行计费（详情页当前标注 5 credits/行），发现与费用估算工具免费。MCP 服务端代码为 MIT，但数据 API 是托管服务；以上是服务商自述，不构成小红书授权证明。由于通用 `request` / `collect` 工具范围较宽且数据调用计费，Tripwise 不直接开放整套工具；若试点，做只读、限行数和单次预算的窄适配器，并先核对条款。其他有用项（Open-Meteo、Travel Risk Aviation）已在本目录评估。目录字段和条目不构成质量、可用性或授权背书。

| 候选 | 适用点 | 当前决定 |
|---|---|---|
| [Open-Meteo](https://open-meteo.com/en/terms) | 当前天气连接器已覆盖逐日预报；实现查询未来 16 天。 | 保持内置，不重复接入。 |
| [QWeather](https://dev.qweather.com/en/docs/api/weather/) | 官方文档列出坐标逐日预报最多 10 天、城市逐日预报 3–30 天，并提供分钟降水、预警和空气质量。 | 若用户需要更长预报或 Open-Meteo 在目标地区持续不可用，再做单城市准确性、配额和许可验证；需要服务凭证，当前不接入。 |
| [Nager.Date](https://github.com/nager/Nager.Date) | 公开 REST API 提供国家及一级行政区节假日信息；目录标为免 Key。官方仓库说明不覆盖城市级节假日。 | 出境行程可用于识别节日客流和营业安排风险；不作景点开放依据。中国调休与补班仍以国务院通知为准。可用时再做来源记录与覆盖验证，不新增默认工具。 |
| [Transitland](https://www.transit.land/documentation/rest-api/) | v2 REST 可查 feed、站点、线路、班次；全部 API 都要 API Key，并按计划设月额度/计费。官方路线平台的公交行程覆盖美国，街道路线覆盖范围更广；不保证中国城市数据。目录的免认证字段不准确。 | 仅当海外目的地存在已核实、许可可用的 feed 和路线能力时评估；不替代中国路线默认使用的高德。 |
| [Navitia](https://doc.navitia.io/) | 多模式公共交通路线、时刻表、实时到发与站点查询；官方文档要求 token，并明确交通数据依赖各地运营网络提供的开放数据。 | 海外目的地的有价值候选。先查目标城市是否有生产覆盖与可用数据，再决定用远程 MCP 或窄适配器；示例 sandbox 不代表真实覆盖。当前不接入、不要求配置 Key。 |
| [transport.rest](https://transport.rest/) | 社区托管的地区公交 API。Berlin/Brandenburg 的 VBB 接口文档称其封装 VBB 移动应用 API，可返回上游提供的实时延误/中断；无需 Key，限流 100 次/分钟。 | 可用于柏林等明确覆盖地的低成本原型；它不是交通运营方的官方 API，需先核对上游使用条款、稳定性和数据展示许可。不是通用 Provider，当前不接入。 |
| [Travel Risk API / 远程 MCP](https://travelriskapi.com/docs/mcp) | 官方 Streamable HTTP MCP 提供航班状态、机场状况和国家风险工具；支持 OAuth 2.1 或 `X-API-Key`。官方免费额度为每月 3,000 次航空调用，超额计划另计费。 | 可作为“航班动态”可选来源；Tripwise 现有远程 MCP 静态请求头可用 Key 模式接入，OAuth 尚不支持。只在用户需要延误/机场等待信息时启用，保留航司/机场官方链接，不替代通知或行李规则。请求会发送航班号/机场代码；服务商称 API 日志含 IP、最长保留 13 个月且在美国处理。当前不接入、不要求 Key。 |
| [Can I enter?](https://canienter.com/developers) | 公开 API 覆盖 199 个护照与 39,402 条护照—目的地组合；免费接口每 IP 每日 5 次，付费接口每次 $0.03，以 Base 网络 USDC 通过 x402 结算。基础签证结论来自聚合二手矩阵；入境规则字段附政府来源链接，状态可为未整理、过期或待复核。[方法](https://canienter.com/methodology) | 可用于出境准备阶段发现签证与入境条件，不进入默认工具集。其规则不能代替官方核验；完整数据集为 [CC BY-NC 4.0](https://canienter.com/terms)，付费 API 另受其服务条款约束。若将来试用，只传护照国家/目的地国家代码与必要日期，不传证件号或已持文件细节，并在结果中并列展示字段来源与核验状态。 |
| Amadeus、Aviationstack | Amadeus 偏航班搜索；Aviationstack 提供航班状态数据。 | 只有出现机票搜索需求时再评估；航班动态优先评估上方的 Travel Risk 远程 MCP，不把任何聚合服务当作行李额度或票规依据，也不开放预订。 |
| Yelp、Foursquare、Tripadvisor | 商户/地点或评价数据，可能补充海外商户发现。 | 暂不接入；与地图 POI 和网页来源重叠，先解决餐馆来源是否直接、匹配口味的问题。 |
| [SocialCrawl 小红书 API / MCP](https://github.com/socialcrawl/mcp) | 小红书公开笔记搜索、热榜、主页、笔记和评论共 6 类端点；搜索返回短摘要，完整正文另查笔记端点。新账户 100 credits；搜索每条返回结果 5 credits，默认 10 条最多约 50 credits。MIT 许可覆盖 MCP 适配器，不覆盖托管数据服务。 | **优先做受限试点，不直接开放通用 MCP 工具。** 当前 MCP 把 `request/collect` 标为非只读（会扣费），Tripwise 只允许只读工具；且通用 `request` 能访问整个平台目录。若接入，做小红书限定的只读适配器：先估价、设单次费用上限和结果条数，仅搜索与打开用户选中的笔记；不接评论、批量采集或 `manage`。保留笔记原始链接与发布时间，注明第三方服务来源；实测质量、费用和服务条款通过后再默认启用。 |
| [Monocrawl MCP](https://github.com/monocrawl/monocrawl-mcp) | 开源 MCP 桥接托管数据服务，官网 Quickstart 称新账户有 150 个免费 credits、无需银行卡；公开平台目录列出 Tripadvisor、Booking.com，未列小红书。 | 暂不接入。可作为海外点评/住宿资料候选，但数据服务后端非开源且与地图/网页研究有重叠；先核验具体端点、来源授权、费用与留存政策。 |
| [ContextFetch MCP](https://github.com/lachy3433/contextfetch-mcp) | MIT MCP 客户端连接托管搜索/网页抽取 API；README 宣称每日 25 次免 Key 额度，超额按量计费。 | 暂不接入默认工具集。可在现有搜索服务额度不足时做小规模中文来源测试；能力与 Exa、Tavily、Firecrawl 重叠，须核实返回来源与数据处理方式。 |
| Mapbox、OpenRouteService 及地区交通 API | 海外地点、路线或地区公交服务。 | 仅按具体目的地评估覆盖、坐标系、展示/缓存许可；不增加通用重复 Provider。 |

结论：public-apis 找到一个值得验证的新增渠道：SocialCrawl 小红书公开笔记。需单独配置该服务 Key；Tripwise 暂未配置或联测。试点应限定公开读取、返回行数和单次预算，不放宽通用 MCP 权限。其余首发渠道保持不变；Nager.Date 是免 Key 的出境节假日候选，海外公交按目的地评估 Navitia。北京实跑暴露的路线绑定、餐馆直证和长任务恢复，仍优先于拓宽渠道数量。

README 另列 `Agent Nexus` 作为工具发现目录；它不是旅行事实源，不接入。


## 当前已接入渠道

| 能力 | 服务/项目 | Tripwise 状态 | 凭证与限制 |
|---|---|---|---|
| 通用网页搜索 | DuckDuckGo HTML | 内置；无需 Key | 独立 API 回退；本机实测曾超时并返回 HTTP 202 验证页。右侧可见浏览器搜索已用 Bing；所有搜索摘要仍只作链接线索。 |
| 增强网页搜索 | Exa Search API、Tavily Search API | 已内置；曾在真实行程中调用；需要个人 Key | 时效事实查询并行检索后按 URL 去重，最多保留 6 条；普通查询单服务优先并回退。每条来源保留实际搜索提供方与原始链接。逐次运行结果见[北京评测](../evaluation/TRAVEL-CASES.md)。 |
| 指定网页正文 | Firecrawl v2 Scrape API | 已内置；曾在真实行程中调用；需要个人 Key | 用户要求开放/预约/票价/班次/航司规则时，应用从首轮搜索结果自动读取相关页面正文：普通核验最多 2 页，详细行程最多 18 页；单页 Markdown 限长，向模型提供并在本机保留最多 2,400 字符事实摘录，来源卡摘要最多 800 字符。遇到 HTTP 402/429 后停止正文服务请求，由右侧研究浏览器按普通 2 页、详细 18 页上限读取已选来源。拒绝私有地址、带凭证链接和小红书，不开放整站 Crawl。逐次运行结果见[北京评测](../evaluation/TRAVEL-CASES.md)。 |
| 右侧网页研究 | Tripwise 内置隔离浏览器 | 已实现；无需额外凭证 | Agent 可导航、读取快照、打开可见链接、每次滚动 1–3 屏，并操作快照列出的同站 GET 搜索框或公开内容展开按钮；右侧展示页面、动作状态与跟随已校验 DOM 目标的页面内指针，用户可停止并接管。视觉读取默认关闭。此路径不读取系统浏览器登录态、不自动登录或绕过验证，也不执行发布、互动或交易。小红书 OpenCLI 是单独连接器。详见 [ADR-0019](../design/adr/0019-browser-scoped-computer-use.md)。 |
| 天气 | Open-Meteo | 内置；无需 Key | 免费公共 API 限非商业使用和服务配额；商业发行或超出配额时要使用其付费计划或换合适的数据服务。数据需遵守 CC BY 4.0 署名要求。[服务条款](https://open-meteo.com/en/terms)、[API 项目](https://github.com/open-meteo/open-meteo) |
| 国内地点、地图底图与路线 | 高德 JS API 2.0 + 高德 Web 服务 | 单一高德服务族已实现；当前路线联测状态见[项目进度](../PROJECT-STATUS.md) | 需要 Web 服务 Key、Web JS API Key 和 JS API 安全密钥。JS API 脚本在线加载；安全密钥由主进程经本机代理附加。高德服务数据保存到旅行版本、备份或导出前，必须确认服务商许可。[JS API 加载](https://lbs.amap.com/api/javascript-api-v2/guide/abc/load)、[安全密钥](https://lbs.amap.com/api/javascript-api-v2/guide/abc/jscode)、[服务条款](https://lbs.amap.com/pages/terms) |
| 高德官方旅行 MCP | 高德 MCP Server | 已支持 Streamable HTTP 预设；真实服务联测待完成 | 复用已保存的 Web 服务 Key；不会把 Key 写进 MCP 地址或普通设置。地点、天气和路线用于扩展来源，路线文本不替代结构化路线记录；个人地图、导航、打车、票务和下单类工具被屏蔽。[快速接入](https://lbs.amap.com/api/mcp-server/gettingstarted)、[官方能力](https://lbs.amap.com/api/mcp-server/summary)、[更新日志](https://lbs.amap.com/api/mcp-server/changelog) |
| 小红书公开攻略 | 隔离浏览器站内搜索；OpenCLI 默认关闭 | OpenCLI 需本机配置 Browser Bridge | 内置浏览器遇登录或验证即停止，用户可接管。可选 OpenCLI 通过已登录 Chrome 会话搜索与读取；Tripwise 不保存 Cookie，连接器以当前账户权限运行。最新公开页测试未读到笔记正文；OpenCLI 当前未联测。见[官方授权范围](https://openaccount.xiaohongshu.com/docs/scope)、[ADR-0008](../design/adr/0008-xiaohongshu-opencli-connector.md)和[ADR-0019](../design/adr/0019-browser-scoped-computer-use.md)。 |
| 自定义插件 | stdio、远程 Streamable HTTP、远程 SSE | 已支持高级用户手动配置 | stdio/Streamable HTTP 自动协商 MCP 2026-07-28 协议并回退兼容旧握手；SSE 仅支持旧协议。远程只支持 HTTPS、静态请求头/查询认证和同源请求；不支持 OAuth、自动安装或插件市场。stdio 命令以当前用户权限运行。每项工具需用户批准；服务声明的只读标记不是隔离措施。[MCP 接入 ADR-0006](../design/adr/0006-mcp-stdio-connectors.md) |

## 后续可选渠道

这些渠道不是首批规划流程的前置条件，暂时不需要提供 Key。

| 能力 | 候选项目/服务 | 凭证 | 适用条件与限制 | 优先级 |
|---|---|---|---|---|
| 搜索备用 | [Brave Search MCP](https://github.com/brave/brave-search-mcp-server) | `BRAVE_API_KEY` | 除网页搜索外，还提供新闻、视频、本地商家和地点搜索；与 Exa/Tavily 重叠。只有首批搜索覆盖或稳定性不足时再申请。 |
| 网页研究/浏览器扩展 | [Jina MCP](https://github.com/jina-ai/MCP)、[Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)、[Crawl4AI](https://github.com/unclecode/crawl4ai) | 依服务计划 | Tripwise 已有内置隔离浏览器，无需重复配置浏览器 MCP。第三方 Playwright MCP 使用独立会话，不能控制右侧页面；新增渠道需先核验授权、隔离和操作范围。 |
| 中国地图备用 | [百度官方地图 MCP](https://github.com/baidu-maps/mcp) | 百度地图服务 Key，按具体 API 权限开通 | POI、地理编码、路线矩阵及交通方式；可作为高德以外的中国地图 Provider，需核对配额、坐标系与地图展示/缓存政策。 |
| 海外地图/路线 | [Mapbox MCP](https://github.com/mapbox/mcp-server)、[Google Maps MCP 示例](https://github.com/apurvaumredkar/google-maps-mcp) | `MAPBOX_ACCESS_TOKEN` 或 Google Maps API Key | 海外地点、路线和距离矩阵的候选。不同区域覆盖与地图展示/缓存条款不同；根据真实目的地测试后再选一个接入。 |
| 自托管路线计算 | [OSRM](https://github.com/Project-OSRM/osrm-backend)、[Valhalla](https://github.com/valhalla/valhalla)、[GraphHopper](https://github.com/graphhopper/graphhopper) | 自托管不需要供应商 Key；托管服务可能需要 Key/付费 | 适合需要减少商业地图依赖或自行控制路由时；需要维护路网数据、更新和服务容量，不能直接替代 POI、公交时刻或营业信息。 |
| 天气备用 | [QWeather API](https://dev.qweather.com/en/docs/api/weather/)；社区 MCP 仅作实现参考 | QWeather 项目凭证；官方建议优先使用 JWT | 只在预报跨度或目标地区覆盖确有缺口时评估；当前不要求配置 Key。分钟降水、预警和空气质量是补充能力，不替代官方景区公告。 |
| 机票搜索 | [Amadeus Self-Service Flights](https://github.com/amadeus4dev/developer-guides/blob/master/docs/resources/flights.md)；社区 MCP 示例：[mcp-amadeus](https://github.com/donghyun-chae/mcp-amadeus) | `AMADEUS_CLIENT_ID` + `AMADEUS_CLIENT_SECRET` | 搜索航班报价、日期、价格和部分行李信息；不是覆盖所有航空公司的完整 OTA 库。只用于只读比价，不开放下单。 |
| 航班动态 | [FlightAware AeroAPI](https://www.flightaware.com/commercial/aeroapi) | FlightAware 用户名 + AeroAPI Key | 可按航班号/机场查询动态、预计时间和航迹；按用量/计划收费。仅在用户明确需要延误/动态提醒时评估。 |
| 铁路与城市公共交通 | 目的地官方交通 API、公开 GTFS 数据；社区旅行项目示例见[竞品与 MCP 仓库调研](../research/scraping-references.md) | 视运营方而定；官方公开数据可能无需 Key | 线路、班次和换乘需按国家/城市选择 Provider。未经授权的 12306/平台接口封装不作为默认来源；票价和余票须回官方渠道确认，不代购。 |
| 酒店/机票预订 | 官方合作伙伴 API（若满足申请条件）+ 官方网页来源 | 通常需合作伙伴账号和审批，不保证个人开发者可申请 | 当前不接下单或支付。搜索页价格、库存和政策会快速变化；没有稳定授权 API 时只提供带来源链接的网页研究，不声称实时可订。 |
| 汇率/预算补充 | 公共汇率数据或受支持的金融数据 API | 取决于提供方；启用前确认商业使用、频率和历史数据许可 | 只用于预算估算，明确币种与更新时间；最终金额以支付服务商或商家页面为准。 |
| 公开视频攻略 | OpenCLI 的站点适配器或独立视频字幕 MCP | 通常不需要 API Key；部分内容需要用户账号会话 | 可补充 B 站等视频攻略的标题、字幕和作者信息。先核对来源标识、字幕质量和登录边界；不抓取私有视频或评论。 |
| 景点/商户补充 | 官方景点页面、公开搜索结果、地图 POI | 通常沿用搜索或地图凭证 | 营业、预约、票价等事实以景点官方页面优先；商户推荐须展示地图/原始网页来源，不把社区评分当作事实。 |
| 社区与点评平台 | 小红书、B 站、点评类平台的官方/授权接口，或用户明确控制的浏览器来源 | 取决于授权产品；不要在聊天中提供 Cookie、密码或会话令牌 | 目前没有为 Tripwise 批准一个通用的点评/社媒私有接口抓取器。只有公开授权、可审计、只读且真实可维护的渠道才进入实现。 |

## 小红书 MCP 候选与边界

小红书仓库不能只按“能搜到笔记”选型，还要核对是否储存 Cookie、是否使用未公开接口、是否包含发布/评论/删除能力、是否能限制为只读，以及平台规则和维护状态。

| 候选 | 仓库声明的认证/能力 | Tripwise 结论 |
|---|---|---|
| [OpenCLI](https://github.com/jackwener/OpenCLI) | 小红书适配器提供搜索、笔记读取；[Browser Bridge](https://github.com/jackwener/OpenCLI/blob/main/docs/guide/browser-bridge.md) 操作用户已登录的 Chrome 页面。项目也提供通用浏览器、下载和账号写入命令，适配器依赖网站结构。 | 保留默认关闭的只读试点。Tripwise 只调用固定搜索和笔记读取命令，不暴露通用浏览器操作工具；OpenCLI/扩展仍以当前账户权限访问 Chrome。当前设备未安装，须实机联测。 |
| [shanyang-me/xhs-mcp](https://github.com/shanyang-me/xhs-mcp) | 项目说明使用本地浏览器 Cookie 和小红书页面内签名，再调用站点内部接口；同一服务还含发布和账号管理工具。 | 不作为默认连接器；不得将 Cookie 发到聊天或普通设置命令中。仅在代码、存储、权限与平台规则审查通过后重评估。 |
| [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) | 提供搜索、读取等工具，同时提供笔记管理/其他账号操作能力；项目持续变更。 | 先审计具体版本与允许工具；只读能力必须在运行时做明确白名单，不能因为 MCP 声称支持只读就自动接入。 |
| [SocialDataX 托管连接信息](https://github.com/devinchen2014/xiaohongshu-xhs-rednote-mcp) | 仓库公布托管 HTTP MCP 的接入面，但业务实现不在公开仓库中，使用服务商 API Key。 | 透明度不足，未完成服务条款、数据去向与撤销机制审查前不连接。 |

上述项目的 README 只证明其作者公开描述了这些行为，不证明平台授权、抓取合法性或长期可用。当前默认路径仍为用户粘贴链接/文字和显式启用的 OpenCLI 只读试点。

## 接入 MCP/API 前的检查

1. 记录项目仓库、维护方、许可证、最近 release、依赖变化与安全公告；外部 README 不能当作权限证明。
2. 对照产品只读范围逐工具检查输入、输出、写操作、Cookie/本地文件访问及数据接收方。
3. 每次只将本轮查询所需字段发送给服务；不传整个旅行 JSON、对话历史或其他连接器密钥。
4. 对搜索结果和网页正文统一保存提供方、抓取时间、原始 URL 和失败状态；网页正文与 MCP 返回值作为不可信内容。
5. 限制单轮调用数、结果数、正文长度、并发和重试；对 Crawl、下载、评论或发布动作默认关闭。
6. 连接测试与日常运行分开；用户明确启用服务并逐项批准工具后才可调用，删除连接时同步清除凭证。
7. 每个来源在首发前重新审核服务条款、许可、平台政策、商业使用限制和目标平台兼容性；缺少可靠官方来源时保留手动导入流程。

## 主要参考

更完整的开源仓库候选按网页检索、地图/路线、天气、桌面 Agent 和旅行产品分类，见[开源竞品与抓取参考仓库调研](../research/scraping-references.md)。该目录记录了社区项目的能力和已知限制，但未逐个运行，因此不是可直接安装或已获授权的插件清单。

- [Exa MCP Server](https://github.com/exa-labs/exa-mcp-server) 与 [Exa MCP 文档](https://exa.ai/docs/reference/exa-mcp)
- [Exa Search API](https://exa.ai/docs/reference/search)
- [Tavily MCP Server](https://github.com/tavily-ai/tavily-mcp) 与 [Tavily MCP 文档](https://docs.tavily.com/documentation/mcp)
- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Firecrawl MCP Server](https://github.com/firecrawl/firecrawl-mcp-server) 与 [Firecrawl MCP 设置文档](https://github.com/firecrawl/firecrawl-docs/blob/main/mcp-server.mdx)
- [Firecrawl Scrape API](https://docs.firecrawl.dev/api-reference/endpoint/scrape)
- [Brave Search MCP Server](https://github.com/brave/brave-search-mcp-server)
- [Mapbox MCP Server](https://github.com/mapbox/mcp-server)
- [百度地图官方 MCP](https://github.com/baidu-maps/mcp)、[Google Maps MCP 示例](https://github.com/apurvaumredkar/google-maps-mcp)
- [Jina MCP](https://github.com/jina-ai/MCP)、[Microsoft Playwright MCP](https://github.com/microsoft/playwright-mcp)、[Crawl4AI](https://github.com/unclecode/crawl4ai)
- [Open-Meteo 服务条款](https://open-meteo.com/en/terms) 与 [源代码仓库](https://github.com/open-meteo/open-meteo)
- [QWeather 预报能力](https://dev.qweather.com/en/docs/api/weather/) 与 [认证说明](https://dev.qweather.com/en/docs/configuration/authentication/)
- [Transitland REST API](https://www.transit.land/documentation/rest-api/) 与 [feed 许可字段](https://www.transit.land/documentation/rest-api/feeds)
- [Transitland 服务覆盖与计费](https://www.transit.land/documentation)：REST 查询、路线服务区域及 API Key/额度说明
- [Monocrawl MCP 开源桥](https://github.com/monocrawl/monocrawl-mcp/tree/2f30650dea337da0d112c8f18daeb4366ac89f8b)、[平台目录](https://www.monocrawl.com/docs/platforms)、[MCP 文档](https://www.monocrawl.com/docs/mcp)、[数据来源说明](https://www.monocrawl.com/legal/public-data)
- [SocialCrawl MCP 开源适配器](https://github.com/socialcrawl/mcp)、[工具权限源码（f74b11b）](https://github.com/socialcrawl/mcp/blob/f74b11b9b4d5d8c17eec8ea1a85a79751949d803/src/server.ts)、[托管 MCP 接入说明](https://www.socialcrawl.dev/docs/skills-and-mcp)、[小红书端点及计费](https://www.socialcrawl.dev/platforms/xiaohongshu)、[公开数据声明](https://www.socialcrawl.dev/legal/public-data-notice)：服务商自述；接入前须实测并审查平台规则。
- [public-apis 目录快照](https://github.com/public-apis/public-apis/tree/88706670ac0ffaad7bf3c6307747e2515f638bed)：按旅行规划需要筛选，不作为可用性、覆盖或授权背书。
- [高德路径规划 Web API](https://lbs.amap.com/api/webservice/guide/api/newroute)
- [OpenCLI](https://github.com/jackwener/OpenCLI)、[XHS MCP 示例](https://github.com/shanyang-me/xhs-mcp)、[Amadeus Flight Search MCP 示例](https://github.com/donghyun-chae/mcp-amadeus)
- 本地设计决策：[MCP stdio 插件](../design/adr/0006-mcp-stdio-connectors.md)、[小红书 OpenCLI](../design/adr/0008-xiaohongshu-opencli-connector.md)；当前实现和产品边界见[技术架构](../design/TECH.md)与[PRD](../PRD.md)。
