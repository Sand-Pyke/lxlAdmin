import {
  Alert,
  App,
  Button,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Upload,
} from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { request, post } from '../api/client';
import {
  imageSource,
  MAX_INT,
  SHOP_CATEGORIES,
  shopFormValues,
  shopPayload,
  validateShopImage,
} from '../api/shop';
import type { ShopForm } from '../api/shop';
import type { ShopItem } from '../api/types';
import { AVATAR_FRAMES, findAvatarFrame } from '../data/avatar-frames';
import { NAMEPLATE_STYLES, SHOP_NAMEPLATE_PRESETS, nameplateImage } from '../data/nameplates';
import { DYNAMIC_BACKGROUNDS } from '../data/dynamic-backgrounds';
import '../styles/shop.css';
import { useViewer } from '../auth';
import { can } from '../permissions/access';
import Permit from './Permit';

async function uploadShopImage(file: File) {
  validateShopImage(file);
  const body = new FormData();
  body.append('file', file);
  const result = await request<{ url: string }>('/api/admin/shop/upload-icon', {
    method: 'POST',
    body,
  });
  if (!imageSource(result.url)) throw new Error('上传服务没有返回有效图片地址');
  return result;
}

export default function ShopEditor({ item, onClose }: { item?: ShopItem; onClose: () => void }) {
  const viewer = useViewer();
  const [form] = Form.useForm<ShopForm>();
  const client = useQueryClient();
  const { message } = App.useApp();
  const category = Form.useWatch('category', form) || item?.category || 'AVATAR_FRAME';
  const icon = Form.useWatch('icon', form) || '';
  const frame = Form.useWatch('avatarFrameStyle', form);
  const effect = Form.useWatch('effectValue', form);
  const name = Form.useWatch('name', form);
  const dynamic = Form.useWatch('dynamicBg', form);
  const canUpload = can(viewer, 'shop.upload');
  const publishedTemplates = useRef(new Map<string, string>());
  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!canUpload) throw new Error('当前账号没有图片上传权限');
      return uploadShopImage(file);
    },
    onSuccess: (result) => {
      form.setFieldValue('icon', result.url);
      void message.success('图片已上传，保存商品后生效');
    },
  });
  const save = useMutation({
    mutationFn: async (values: ShopForm) => {
      const body = shopPayload(values, item);
      const template = SHOP_NAMEPLATE_PRESETS.find((plate) => plate.value === body.effectValue);
      if (category === 'NAMEPLATE' && template) {
        if (!canUpload) throw new Error('当前账号没有图片上传权限');
        let url = publishedTemplates.current.get(template.value);
        if (!url) {
          const asset = await fetch(template.image, { signal: AbortSignal.timeout(10_000) });
          if (!asset.ok || !asset.headers.get('content-type')?.includes('image/svg+xml'))
            throw new Error('动态铭牌素材暂不可用，请刷新后重试');
          const image = new File([await asset.blob()], template.filename, {
            type: 'image/svg+xml',
          });
          url = (await uploadShopImage(image)).url;
          publishedTemplates.current.set(template.value, url);
        }
        body.icon = url;
        body.effectValue = 'custom';
      }
      return post(item ? `/api/admin/shop/${item.id}` : '/api/admin/shop/create', body);
    },
    onSuccess: async (data) => {
      void message.success(data.msg || '商品已保存');
      onClose();
      await client.invalidateQueries({ queryKey: ['shop'] });
    },
  });
  const busy = save.isPending || upload.isPending;
  const customImage =
    category === 'BACKGROUND'
      ? !dynamic
      : category === 'AVATAR_FRAME'
        ? !frame
        : category === 'NAMEPLATE'
          ? effect === 'custom'
          : true;
  const preview =
    category === 'AVATAR_FRAME' && frame
      ? findAvatarFrame(frame)?.image
      : category === 'NAMEPLATE' && effect !== 'custom'
        ? SHOP_NAMEPLATE_PRESETS.find((plate) => plate.value === effect)?.image ||
          nameplateImage(effect || 'champion')
        : imageSource(icon);
  return (
    <Modal
      open
      title={item ? `编辑商品 #${item.id}` : '新建商品'}
      width={760}
      onCancel={() => {
        if (!busy) onClose();
      }}
      onOk={() => form.submit()}
      okText="保存商品"
      cancelText="取消"
      confirmLoading={save.isPending}
      okButtonProps={{
        disabled:
          upload.isPending || upload.isError || !can(viewer, item ? 'shop.update' : 'shop.create'),
      }}
      cancelButtonProps={{ disabled: busy }}
      closable={!busy}
      maskClosable={!busy}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={shopFormValues(item)}
        onFinish={(values) => save.mutate(values)}
        disabled={busy}
        requiredMark={false}
        style={{ marginTop: 24 }}
      >
        {save.error && (
          <Alert
            showIcon
            type="error"
            title="保存未完成"
            description={save.error.message}
            style={{ marginBottom: 20 }}
          />
        )}
        <Row gutter={20}>
          <Col xs={24} sm={12}>
            <Form.Item
              name="category"
              label="商品分类"
              rules={[{ required: true }]}
              extra={item ? '已有商品保留原分类与道具效果。' : undefined}
            >
              <Select
                virtual={false}
                disabled={Boolean(item)}
                options={[
                  ...SHOP_CATEGORIES,
                  ...(item?.category === 'THEME'
                    ? [{ value: 'THEME', label: '主题（历史商品）' }]
                    : []),
                ]}
                onChange={(value) => {
                  upload.reset();
                  form.setFieldsValue({
                    icon: '',
                    effectValue: value === 'NAMEPLATE' ? 'champion' : '',
                    avatarFrameStyle: value === 'AVATAR_FRAME' ? 'gold' : '',
                    dynamicBg: '',
                  });
                }}
              />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="name"
              label="商品名称"
              rules={[{ required: true, whitespace: true, message: '请填写商品名称' }]}
            >
              <Input placeholder="请输入商品名称" />
            </Form.Item>
          </Col>
        </Row>
        {category === 'AVATAR_FRAME' && (
          <Form.Item name="avatarFrameStyle" label="头像框样式">
            <Select
              virtual={false}
              showSearch
              optionFilterProp="label"
              options={[
                ...AVATAR_FRAMES.map((frame) => ({ value: frame.value, label: frame.label })),
                { value: '', label: '自定义图片' },
              ]}
              onChange={(value) => {
                upload.reset();
                form.setFieldValue('icon', findAvatarFrame(value)?.image || '');
              }}
            />
          </Form.Item>
        )}
        {category === 'NAMEPLATE' && (
          <Form.Item name="effectValue" label="铭牌样式">
            <Select
              virtual={false}
              showSearch
              optionFilterProp="label"
              options={[
                ...NAMEPLATE_STYLES.map((plate) => ({ value: plate.value, label: plate.label })),
                ...(canUpload ? [{ label: '动态模板', options: SHOP_NAMEPLATE_PRESETS }] : []),
                { value: 'custom', label: '自定义横幅' },
              ]}
              onChange={(value) => {
                upload.reset();
                const template = SHOP_NAMEPLATE_PRESETS.find((plate) => plate.value === value);
                if (template && !form.getFieldValue('name')?.trim())
                  form.setFieldValue('name', template.name);
              }}
            />
          </Form.Item>
        )}
        {category === 'TITLE' && (
          <Form.Item
            name="effectValue"
            label="称号文本"
            extra="留空时，新商品默认使用商品名称；已有自定义称号保留原文本。"
          >
            <Input placeholder="例如：ADKING" />
          </Form.Item>
        )}
        {category === 'BACKGROUND' && (
          <Form.Item name="dynamicBg" label="背景样式">
            <Select
              virtual={false}
              options={[
                { value: '', label: '自定义背景图片' },
                ...DYNAMIC_BACKGROUNDS.map((background) => ({
                  value: background.key,
                  label: background.label,
                })),
              ]}
              onChange={(value) => {
                upload.reset();
                if (value) form.setFieldValue('icon', '');
              }}
            />
          </Form.Item>
        )}
        {category === 'ITEM_CARD' && (
          <Alert
            type="info"
            showIcon
            title={
              item
                ? '保留已有道具的专用效果；此处修改商品销售资料。'
                : '新建通用商品不会自动获得免 ban、解禁等专用道具功能。'
            }
            style={{ marginBottom: 20 }}
          />
        )}
        {customImage && (
          <>
            <Form.Item label="商品图片">
              <Space wrap>
                <Permit permission="shop.upload">
                  <Upload
                    accept=".jpg,.jpeg,.png,.gif,.webp,.svg"
                    showUploadList={false}
                    beforeUpload={(file) => {
                      upload.mutate(file);
                      return false;
                    }}
                    disabled={busy}
                  >
                    <Button icon={<UploadOutlined />} loading={upload.isPending} disabled={busy}>
                      上传图片
                    </Button>
                  </Upload>
                </Permit>
                {icon && (
                  <Button
                    disabled={busy}
                    onClick={() => {
                      form.setFieldValue('icon', '');
                      upload.reset();
                    }}
                  >
                    清除图片
                  </Button>
                )}
              </Space>
              <p className="shop-help">
                支持 JPG / PNG / GIF / WebP / SVG，单张不超过 5MB。铭牌建议使用 1000 × 160 横幅。
              </p>
            </Form.Item>
            <Form.Item name="icon" label="图片地址或图标">
              <Input placeholder="上传后自动填写，也可保留现有图标" />
            </Form.Item>
          </>
        )}
        {!customImage && (
          <Form.Item name="icon" hidden>
            <Input />
          </Form.Item>
        )}
        {upload.error && (
          <Alert
            showIcon
            type="error"
            title="图片上传失败"
            description={upload.error.message}
            action={
              <Button size="small" onClick={() => upload.reset()}>
                保留当前图片
              </Button>
            }
            style={{ marginBottom: 20 }}
          />
        )}
        <div
          className={`shop-preview ${category === 'NAMEPLATE' ? 'shop-preview-wide' : ''}`}
          aria-label="商品预览"
        >
          {preview ? (
            <img src={preview} alt="商品图片预览" />
          ) : category === 'AVATAR_FRAME' && frame === 'gold' ? (
            <div className="shop-gold-frame">LXL</div>
          ) : category === 'TITLE' ? (
            <Tag color="gold">{effect || name || '称号预览'}</Tag>
          ) : category === 'BACKGROUND' && dynamic ? (
            <Tag color="green">
              动态背景：{DYNAMIC_BACKGROUNDS.find((bg) => bg.key === dynamic)?.label || dynamic}
            </Tag>
          ) : (
            <span className="muted">
              {icon && !imageSource(icon) ? icon : '上传或选择样式后预览'}
            </span>
          )}
        </div>
        <Row gutter={20}>
          <Col xs={24} sm={12}>
            <Form.Item
              name="price"
              label="价格（冠军币）"
              rules={[{ required: true, message: '请填写价格' }]}
              extra="0 币仅限设置了领取资格的商品。"
            >
              <InputNumber min={0} max={MAX_INT} style={{ width: '100%' }} />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item
              name="durationDays"
              label="有效期（天）"
              extra="留空表示永久；消耗型道具按业务规则使用。"
            >
              <InputNumber min={1} max={MAX_INT} style={{ width: '100%' }} placeholder="永久" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={20}>
          <Col xs={24} sm={12}>
            <Form.Item name="eligibleMinUserId" label="领取起始名次（User.id）">
              <InputNumber min={1} max={MAX_INT} style={{ width: '100%' }} placeholder="不限" />
            </Form.Item>
          </Col>
          <Col xs={24} sm={12}>
            <Form.Item name="eligibleMaxUserId" label="领取截止名次（User.id）">
              <InputNumber min={1} max={MAX_INT} style={{ width: '100%' }} placeholder="不限" />
            </Form.Item>
          </Col>
        </Row>
        {item ? (
          <Row gutter={20}>
            <Col xs={24} sm={12}>
              <Form.Item name="stock" label="库存" extra="留空不限，0 表示售罄。">
                <InputNumber
                  min={0}
                  max={MAX_INT}
                  style={{ width: '100%' }}
                  placeholder="不限库存"
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item name="enabled" label="上架状态" valuePropName="checked">
                <Switch checkedChildren="上架" unCheckedChildren="下架" />
              </Form.Item>
            </Col>
          </Row>
        ) : (
          <Alert
            type="info"
            title="新商品默认上架且不限库存，创建后可编辑库存和上下架状态。"
            style={{ marginBottom: 20 }}
          />
        )}
        <Form.Item name="description" label="商品描述">
          <Input.TextArea rows={3} placeholder="请输入商品说明" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
