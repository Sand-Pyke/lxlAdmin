import { App as AntApp, Alert, Button, ConfigProvider, Result, theme } from 'antd';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BigScreenDraft } from '../components/draft/big-screen-draft';
import { useViewer } from '../auth';
import { can } from '../permissions/access';
import { loadDraftMusic } from '../api/draft';
import '../styles/draft.css';

export default function Draft() {
  const { id = '' } = useParams();
  const viewer = useViewer();
  const valid = /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0;
  const allowed = can(viewer, 'draft.view') && can(viewer, 'draft.control');
  const music = useQuery({
    queryKey: ['draft-music'],
    queryFn: ({ signal }) => loadDraftMusic(signal),
    enabled: valid && allowed,
    staleTime: 5 * 60_000,
  });
  if (!valid)
    return (
      <Result status="404" title="赛事编号无效" extra={<Link to="/matches">返回赛事管理</Link>} />
    );
  if (!allowed)
    return (
      <Result
        status="403"
        title="没有大屏选人权限"
        extra={<Link to="/matches">返回赛事管理</Link>}
      />
    );
  return (
    <ConfigProvider
      theme={{
        algorithm: theme.darkAlgorithm,
        token: {
          colorPrimary: '#5878ed',
          colorBgBase: '#090e19',
          colorText: '#f3f6ff',
          zIndexPopupBase: 1400,
        },
        components: { Message: { zIndexPopup: 2000 } },
      }}
    >
      <AntApp>
        {music.error && (
          <Alert
            className="draft-music-load-error"
            type="warning"
            showIcon
            title="音乐列表加载失败，选人仍可继续"
            description={music.error.message}
            action={<Button onClick={() => void music.refetch()}>重新加载音乐</Button>}
          />
        )}
        <BigScreenDraft key={id} matchId={id} musicTracks={music.data?.tracks || []} />
      </AntApp>
    </ConfigProvider>
  );
}
